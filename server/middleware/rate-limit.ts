import crypto from "node:crypto";
import net from "node:net";
import { sql } from "drizzle-orm";
import { db } from "../../config/db";

export interface RateBucket {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export type RateLimitBackendMode = "redis" | "database" | "memory-test";

const memoryBuckets = new Map<string, RateBucket>();
const keyLocks = new Map<string, Promise<unknown>>();
let forcedBackendForTests: RateLimitBackendMode | null = null;

/**
 * Allows isolated automated tests to select a specific rate-limit store.
 * Prohibited in production.
 */
export function setRateLimitBackendForTests(
  mode: RateLimitBackendMode | null
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Cannot override rate-limit backend in production.");
  }
  forcedBackendForTests = mode;
}

export function resetAllRateLimitsForTests(): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }
  memoryBuckets.clear();
  keyLocks.clear();
}

export function getActiveKeyLockCountForTests(): number {
  return keyLocks.size;
}

function pruneExpiredMemoryBuckets(now: number): void {
  if (memoryBuckets.size < 1000) return;
  for (const [k, bucket] of memoryBuckets.entries()) {
    if (bucket.resetAt <= now) {
      memoryBuckets.delete(k);
    }
  }
}

/**
 * Serializes concurrent rate-limit operations on the same key within a process
 * and cleans up the exact chained promise entry once completed.
 */
async function withKeyLock<T>(
  hashedKey: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = keyLocks.get(hashedKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });

  const chained = previous.then(
    () => current,
    () => current
  );
  keyLocks.set(hashedKey, chained);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (keyLocks.get(hashedKey) === chained) {
      keyLocks.delete(hashedKey);
    }
  }
}

/**
 * Hashes raw rate-limit identifiers (such as normalized emails or IP addresses)
 * with SHA-256 so rate-limit storage never exposes whether an account exists.
 */
export function hashRateLimitKey(scope: string, identifier: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${scope}:${identifier.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 40);
  return `ratelimit:${scope}:${digest}`;
}

/**
 * Extracts a validated client IP address using trusted proxy configuration.
 * Only honors forwarded headers (`cf-connecting-ip`, `x-real-ip`, `x-forwarded-for`)
 * when running behind a trusted reverse proxy (`TRUST_PROXY=true`, `VERCEL=1`, or Cloudflare).
 */
export function extractTrustedClientIp(
  headers: Record<string, string | undefined>,
  fallbackIp = "127.0.0.1"
): string {
  const trustProxy =
    process.env.TRUST_PROXY === "true" ||
    process.env.VERCEL === "1" ||
    Boolean(process.env.CF_PAGES);

  const normalizeCandidate = (raw?: string): string | null => {
    if (!raw) return null;
    const first = raw.split(",")[0]?.trim() || "";
    if (!first) return null;
    const withoutPort =
      first.includes(":") && net.isIP(first) === 0
        ? first.replace(/:\d+$/, "")
        : first;
    return net.isIP(withoutPort) !== 0 ? withoutPort : null;
  };

  if (trustProxy) {
    const cfIp = normalizeCandidate(headers["cf-connecting-ip"]);
    if (cfIp) return cfIp;

    const realIp = normalizeCandidate(headers["x-real-ip"]);
    if (realIp) return realIp;

    const forwardedIp = normalizeCandidate(headers["x-forwarded-for"]);
    if (forwardedIp) return forwardedIp;
  }

  return normalizeCandidate(fallbackIp) ?? "127.0.0.1";
}

const REDIS_ATOMIC_RATE_LIMIT_LUA = `
local current = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if current == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]))
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`;

async function checkUpstashRedisRateLimit(
  hashedKey: string,
  maxRequests: number,
  windowMs: number
): Promise<RateLimitResult> {
  const url = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("Upstash Redis credentials are not configured.");
  }

  // Single atomic Redis EVAL ensuring INCR + PEXPIRE execute indivisibly
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      "EVAL",
      REDIS_ATOMIC_RATE_LIMIT_LUA,
      "1",
      hashedKey,
      String(windowMs),
    ]),
  });

  if (!response.ok) {
    throw new Error(`Redis rate-limit request failed (${response.status})`);
  }

  const payload = (await response.json()) as {
    result?: [number, number] | number[];
  };
  const count = Number(payload?.result?.[0] ?? 1);
  const rawPttl = Number(payload?.result?.[1] ?? windowMs);
  const pttl = rawPttl > 0 ? rawPttl : windowMs;

  if (count > maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil(pttl / 1000)),
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - count),
    retryAfterSeconds: 0,
  };
}

async function checkDatabaseRateLimit(
  hashedKey: string,
  maxRequests: number,
  windowMs: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const nextResetAt = now + windowMs;

  // Single atomic PostgreSQL UPSERT eliminates multi-instance read-modify-write races
  const result = await db.execute<{
    setting_value: { count: number; resetAt: number };
  }>(sql`
    INSERT INTO platform_settings (setting_key, setting_value, category, description, updated_at)
    VALUES (
      ${hashedKey},
      jsonb_build_object('count', 1, 'resetAt', ${nextResetAt}::bigint),
      'RATE_LIMIT_INTERNAL',
      'Shared rate-limit window state',
      to_timestamp(${now}::double precision / 1000.0)
    )
    ON CONFLICT (setting_key) DO UPDATE SET
      setting_value = CASE
        WHEN COALESCE((platform_settings.setting_value->>'resetAt')::bigint, 0) <= ${now}::bigint
          THEN jsonb_build_object('count', 1, 'resetAt', ${nextResetAt}::bigint)
        ELSE
          jsonb_build_object(
            'count', COALESCE((platform_settings.setting_value->>'count')::int, 0) + 1,
            'resetAt', COALESCE((platform_settings.setting_value->>'resetAt')::bigint, ${nextResetAt}::bigint)
          )
      END,
      category = 'RATE_LIMIT_INTERNAL',
      updated_at = to_timestamp(${now}::double precision / 1000.0)
    RETURNING setting_value
  `);

  const rows =
    Array.isArray(result)
      ? result
      : ((result as { rows?: Array<{ setting_value: RateBucket }> })?.rows ?? []);
  const bucket = rows[0]?.setting_value;
  if (!bucket || typeof bucket.count !== "number") {
    throw new Error("PostgreSQL atomic rate-limit upsert returned no bucket.");
  }

  const count = Number(bucket.count);
  const resetAt = Number(bucket.resetAt || nextResetAt);

  if (count > maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - count),
    retryAfterSeconds: 0,
  };
}

function checkMemoryRateLimit(
  hashedKey: string,
  maxRequests: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  pruneExpiredMemoryBuckets(now);
  const existing = memoryBuckets.get(hashedKey);

  if (!existing || existing.resetAt <= now) {
    memoryBuckets.set(hashedKey, {
      count: 1,
      resetAt: now + windowMs,
    });
    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - 1),
      retryAfterSeconds: 0,
    };
  }

  if (existing.count >= maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - existing.count),
    retryAfterSeconds: 0,
  };
}

/**
 * Distributed shared rate limiter with per-key concurrency locking and automatic lock cleanup.
 * Uses atomic Lua scripts for Redis and single-statement atomic SQL upserts for PostgreSQL.
 * Fails closed in production when shared rate-limiting infrastructure is unavailable.
 */
export async function checkRateLimit(
  rawKey: string,
  maxRequests: number,
  windowMs: number
): Promise<RateLimitResult> {
  const [scope, ...rest] = rawKey.split(":");
  const hashedKey = hashRateLimitKey(
    scope || "default",
    rest.join(":") || rawKey
  );

  return withKeyLock(hashedKey, async () => {
    if (forcedBackendForTests === "memory-test") {
      return checkMemoryRateLimit(hashedKey, maxRequests, windowMs);
    }

    const hasUpstash = Boolean(
      process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    );

    try {
      if (hasUpstash || forcedBackendForTests === "redis") {
        return await checkUpstashRedisRateLimit(
          hashedKey,
          maxRequests,
          windowMs
        );
      }

      return await checkDatabaseRateLimit(hashedKey, maxRequests, windowMs);
    } catch (error) {
      console.error("[RateLimiter] Shared rate-limit backend error:", {
        backend: hasUpstash ? "redis" : "database",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });

      // Fail closed in production if shared rate-limiting infrastructure is unavailable
      if (process.env.NODE_ENV === "production") {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: 60,
        };
      }

      return checkMemoryRateLimit(hashedKey, maxRequests, windowMs);
    }
  });
}
