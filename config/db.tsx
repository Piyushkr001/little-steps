import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/littlesteps";

export const sqlClient = neon(connectionString);
export const db = drizzle(connectionString);
export { schema };
