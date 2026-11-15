import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export type AppDatabase = NeonHttpDatabase<Record<string, never>>;

let cachedDefaultDb: AppDatabase | null = null;
let cachedConnectionString: string | null = null;
let testDbOverride: AppDatabase | null = null;

function getDefaultDb(): AppDatabase {
  const connectionString =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/littlesteps";

  if (!cachedDefaultDb || cachedConnectionString !== connectionString) {
    const sqlClient = neon(connectionString);
    cachedDefaultDb = drizzle({ client: sqlClient });
    cachedConnectionString = connectionString;
  }

  return cachedDefaultDb;
}

/**
 * Allows isolated automated tests to inject a separate test database adapter
 * so tests never mutate the live Neon PostgreSQL database.
 */
export function setDatabaseInstanceForTests(override: AppDatabase | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Database instance override is prohibited in production.");
  }
  testDbOverride = override;
}

export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop, receiver) {
    const active = testDbOverride ?? getDefaultDb();
    const value = Reflect.get(active, prop, receiver);
    return typeof value === "function" ? value.bind(active) : value;
  },
});

export { schema };
