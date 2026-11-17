import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

export type AppDatabase = NeonDatabase<Record<string, never>>;

/**
 * Shared query/mutation interface accepted by service helpers that operate either
 * standalone (`db`) or inside a genuine PostgreSQL transaction callback (`tx`).
 */
export type DbClientOrTx = Pick<
  AppDatabase,
  "select" | "insert" | "update" | "delete" | "execute"
>;

export class DatabaseConfigurationError extends Error {
  readonly code = "DATABASE_CONFIGURATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

let cachedPool: Pool | null = null;
let cachedDefaultDb: AppDatabase | null = null;
let cachedConnectionString: string | null = null;
let testDbOverride: AppDatabase | null = null;

function ensureWebSocketConstructor(): void {
  if (
    !neonConfig.webSocketConstructor &&
    typeof globalThis.WebSocket === "function"
  ) {
    neonConfig.webSocketConstructor = globalThis.WebSocket;
  }
}

function validateDatabaseUrl(rawUrl: string | undefined, envKey: string): string {
  const trimmed = rawUrl?.trim();
  if (!trimmed) {
    throw new DatabaseConfigurationError(
      `Required database environment variable ${envKey} is missing.`
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new DatabaseConfigurationError(
      `Configured ${envKey} is not a valid PostgreSQL connection URL.`
    );
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new DatabaseConfigurationError(
      `Configured ${envKey} must use the postgres:// or postgresql:// protocol.`
    );
  }

  if (!parsed.hostname) {
    throw new DatabaseConfigurationError(
      `Configured ${envKey} is missing a database host.`
    );
  }

  return trimmed;
}

/**
 * Resolves the database connection string cleanly by runtime environment:
 * - production: requires DATABASE_URL exclusively; rejects test DB usage.
 * - test: requires TEST_DATABASE_URL exclusively to protect live databases.
 * - development / other: requires DATABASE_URL explicitly (no hardcoded fallback).
 */
export function resolveDatabaseConnectionString(
  env: NodeJS.ProcessEnv = process.env
): string {
  const nodeEnv = env.NODE_ENV || "development";

  if (nodeEnv === "production") {
    const prodUrl = validateDatabaseUrl(env.DATABASE_URL, "DATABASE_URL");
    const testUrl = env.TEST_DATABASE_URL?.trim();
    if (testUrl && testUrl === prodUrl) {
      throw new DatabaseConfigurationError(
        "Production DATABASE_URL cannot match TEST_DATABASE_URL."
      );
    }
    return prodUrl;
  }

  if (nodeEnv === "test") {
    return validateDatabaseUrl(env.TEST_DATABASE_URL, "TEST_DATABASE_URL");
  }

  return validateDatabaseUrl(env.DATABASE_URL, "DATABASE_URL");
}

function getDefaultDb(): AppDatabase {
  const connectionString = resolveDatabaseConnectionString();

  if (!cachedDefaultDb || cachedConnectionString !== connectionString) {
    ensureWebSocketConstructor();

    if (cachedPool) {
      void cachedPool.end().catch(() => {});
    }

    const pool = new Pool({
      connectionString,
      max: process.env.NODE_ENV === "production" ? 10 : 5,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 10_000,
    });

    pool.on("error", (err: unknown) => {
      // Never log connection strings or credentials
      console.error("[Database Pool Error]", {
        name: err instanceof Error ? err.name : "PoolError",
        code: (err as { code?: string })?.code ?? "UNKNOWN",
      });
    });

    cachedPool = pool;
    cachedDefaultDb = drizzle({ client: pool });
    cachedConnectionString = connectionString;
  }

  return cachedDefaultDb;
}

/**
 * Allows isolated automated tests to inject an isolated database adapter.
 * Strictly prohibited in production environments.
 */
export function setDatabaseInstanceForTests(override: AppDatabase | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Database instance override is prohibited in production.");
  }
  testDbOverride = override;
}

/**
 * Closes any active connection pool cleanly (used by integration test runners).
 */
export async function closeDatabasePool(): Promise<void> {
  if (cachedPool) {
    const poolToClose = cachedPool;
    cachedPool = null;
    cachedDefaultDb = null;
    cachedConnectionString = null;
    await poolToClose.end();
  }
}

export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop, receiver) {
    if (testDbOverride) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("Database instance override is prohibited in production.");
      }
      const value = Reflect.get(testDbOverride, prop, receiver);
      return typeof value === "function" ? value.bind(testDbOverride) : value;
    }

    const active = getDefaultDb();
    const value = Reflect.get(active, prop, receiver);
    return typeof value === "function" ? value.bind(active) : value;
  },
});

export { schema };
