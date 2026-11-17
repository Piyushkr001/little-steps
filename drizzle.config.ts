import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

dotenv.config({ quiet: true });

function getMigrationDatabaseUrl(): string {
  const target = process.env.DRIZZLE_TARGET;
  const nodeEnv = process.env.NODE_ENV || "development";

  if (target === "test") {
    if (nodeEnv === "production") {
      throw new Error(
        "Refusing to run Drizzle CLI against TEST_DATABASE_URL in production."
      );
    }
    const testUrl = process.env.TEST_DATABASE_URL?.trim();
    if (!testUrl) {
      throw new Error(
        "TEST_DATABASE_URL is required when DRIZZLE_TARGET=test."
      );
    }
    return testUrl;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required in the environment to run Drizzle CLI."
    );
  }
  return databaseUrl;
}

export default defineConfig({
  schema: "./config/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: getMigrationDatabaseUrl(),
  },
});
