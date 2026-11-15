import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

const connectionString =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/littlesteps";

export const sqlClient = neon(connectionString);
const defaultDb = drizzle({ client: sqlClient });

export type AppDatabase = typeof defaultDb;

let testDbOverride: AppDatabase | null = null;

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

export const db: AppDatabase = new Proxy(defaultDb, {
  get(target, prop, receiver) {
    const active = testDbOverride ?? target;
    const value = Reflect.get(active, prop, receiver);
    return typeof value === "function" ? value.bind(active) : value;
  },
});

export { schema };
