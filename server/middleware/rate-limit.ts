import crypto from "node:crypto";
import net from "node:net";
import { eq } from "drizzle-orm";
import { db } from "../../config/db";
import { platformSettings } from "../../config/schema";

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
 * Allows isolated automated tests to select the in-memory concurrency-locked
 * rate-limit store so tests do not write to the live Neon database.
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
}

/**
 * Serializes concurrent rate-limit operations on the same key within a process
 * so simultaneous bursts cannot bypass window counters.
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
  keyLocks.set(
    hashedKey,
    previous.then(() => current)
  );

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (keyLocks.get(hashedKey) === current) {
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
    // Strip port if IPv4:port format
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

  const pipelineResponse = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      ["INCR", hashedKey],
      ["PTTL", hashedKey],
    ]),
  });

  if (!pipelineResponse.ok) {
    throw new Error(`Redis rate-limit request failed (${pipelineResponse.status})`);
  }

  const results = (await pipelineResponse.json()) as Array<{ result: number }>;
  const count = Number(results?.[0]?.result ?? 1);
  let pttl = Number(results?.[1]?.result ?? -1);

  if (count === 1 || pttl < 0) {
    await fetch(`${url}/pexpire/${encodeURIComponent(hashedKey)}/${windowMs}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    pttl = windowMs;
  }

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
  const [existing] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.settingKey, hashedKey))
    .limit(1);

  const parsed =
    existing &&
    typeof existing.settingValue === "object" &&
    existing.settingValue !== null
      ? (existing.settingValue as { count?: number; resetAt?: number })
      : null;

  if (!existing || !parsed || typeof parsed.resetAt !== "number" || parsed.resetAt <= now) {
    const bucket: RateBucket = {
      count: 1,
      resetAt: now + windowMs,
    };

    if (!existing) {
      await db.insert(platformSettings).values({
        settingKey: hashedKey,
        settingValue: bucket,
        category: "RATE_LIMIT_INTERNAL",
        description: "Shared rate-limit window state",
        updatedAt: new Date(now),
      });
    } else {
      await db
        .update(platformSettings)
        .set({
          settingValue: bucket,
          category: "RATE_LIMIT_INTERNAL",
          updatedAt: new Date(now),
        })
        .where(eq(platformSettings.id, existing.id));
    }

    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - 1),
      retryAfterSeconds: 0,
    };
  }

  const currentCount = Number(parsed.count ?? 0);
  if (currentCount >= maxRequests) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((parsed.resetAt - now) / 1000)
    );
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds,
    };
  }

  const nextCount = currentCount + 1;
  await db
    .update(platformSettings)
    .set({
      settingValue: {
        count: nextCount,
        resetAt: parsed.resetAt,
      },
      updatedAt: new Date(now),
    })
    .where(eq(platformSettings.id, existing.id));

  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - nextCount),
    retryAfterSeconds: 0,
  };
}

function checkMemoryRateLimit(
  hashedKey: string,
  maxRequests: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
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
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((existing.resetAt - now) / 1000)
    );
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds,
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
 * Production-grade shared rate limiter with per-key concurrency serialization.
 * Uses Upstash Redis when configured, or shared PostgreSQL window counters,
 * and fails closed in production if shared rate-limiting infrastructure is unreachable.
 */
export async function checkRateLimit(
  rawKey: string,
  maxRequests: number,
  windowMs: number
): Promise<RateLimitResult> {
  const [scope, ...rest] = rawKey.split(":");
  const hashedKey = hashRateLimitKey(scope || "default", rest.join(":") || rawKey);

  return withKeyLock(hashedKey, async () => {
    // Also enforce in-memory gate inside the process lock for immediate burst defense
    const localResult = checkMemoryRateLimit(hashedKey, maxRequests, windowMs);
    if (!localResult.allowed) {
      return localResult;
    }

    if (forcedBackendForTests === "memory-test") {
      return localResult;
    }

    const hasUpstash = Boolean(
      process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    );

    try {
      if (hasUpstash || forcedBackendForTests === "redis") {
        return await checkUpstashRedisRateLimit(hashedKey, maxRequests, windowMs);
      }

      return await checkDatabaseRateLimit(hashedKey, maxRequests, windowMs);
    } catch (error) {
      console.error("[RateLimiter] Shared rate-limit backend error:", {
        backend: hasUpstash ? "redis" : "database",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });

      // Fail securely (closed) in production if shared rate-limiting infrastructure is unavailable
      if (process.env.NODE_ENV === "production") {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: 60,
        };
      }

      return localResult;
    }
  });
}
