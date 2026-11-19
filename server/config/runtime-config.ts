import { resolveDatabaseConnectionString } from "../../config/db";
import { resolveSmtpTransportConfig } from "../mail/nodemailer";
import { validateCryptographicSecret } from "../security/crypto";
import { validateClamAvConfiguration } from "../services/document-scanner.service";
import { resolveS3StorageConfig } from "../services/s3-storage.adapter";

export type ConfigCheckStatus = "OK" | "WARN" | "ERROR";

export interface ConfigCheckItem {
  category:
    | "database"
    | "adminOtpSecret"
    | "adminSessionSecret"
    | "smtp"
    | "documentStorage"
    | "malwareScanner"
    | "appUrl"
    | "rateLimiter";
  status: ConfigCheckStatus;
  summary: string;
}

export interface RuntimeConfigurationReport {
  environment: string;
  productionReady: boolean;
  documentStorageDriver: "s3" | "local" | "unconfigured";
  documentUploadsEnabled: boolean;
  scannerConfigured: boolean;
  checks: ConfigCheckItem[];
}

/**
 * Safely validates all required runtime and deployment configuration categories.
 * Never prints, logs, or embeds actual secret values, credentials, bucket names,
 * scanner hosts, or connection strings in the returned report.
 */
export function validateRuntimeConfiguration(
  env: NodeJS.ProcessEnv = process.env
): RuntimeConfigurationReport {
  const environment = env.NODE_ENV || "development";
  const isProd = environment === "production";
  const checks: ConfigCheckItem[] = [];

  // 1. Database configuration
  try {
    resolveDatabaseConnectionString(env);
    checks.push({
      category: "database",
      status: "OK",
      summary: "Database connection URL format and environment separation validated.",
    });
  } catch (err) {
    checks.push({
      category: "database",
      status: "ERROR",
      summary:
        err instanceof Error
          ? err.message
          : "Database connection configuration is invalid.",
    });
  }

  // 2. Admin OTP HMAC secret
  try {
    validateCryptographicSecret(
      env.ADMIN_OTP_HMAC_SECRET,
      "ADMIN_OTP_HMAC_SECRET"
    );
    checks.push({
      category: "adminOtpSecret",
      status: "OK",
      summary: "ADMIN_OTP_HMAC_SECRET meets cryptographic entropy requirements.",
    });
  } catch (err) {
    checks.push({
      category: "adminOtpSecret",
      status: "ERROR",
      summary:
        err instanceof Error
          ? err.message
          : "ADMIN_OTP_HMAC_SECRET is missing or weak.",
    });
  }

  // 3. Admin session secret
  try {
    validateCryptographicSecret(
      env.ADMIN_SESSION_SECRET,
      "ADMIN_SESSION_SECRET"
    );
    checks.push({
      category: "adminSessionSecret",
      status: "OK",
      summary: "ADMIN_SESSION_SECRET meets cryptographic entropy requirements.",
    });
  } catch (err) {
    checks.push({
      category: "adminSessionSecret",
      status: "ERROR",
      summary:
        err instanceof Error
          ? err.message
          : "ADMIN_SESSION_SECRET is missing or weak.",
    });
  }

  // 4. SMTP configuration
  try {
    resolveSmtpTransportConfig(env);
    checks.push({
      category: "smtp",
      status: "OK",
      summary: "SMTP delivery credentials are present and preserved verbatim.",
    });
  } catch (err) {
    checks.push({
      category: "smtp",
      status: isProd ? "ERROR" : "WARN",
      summary:
        err instanceof Error
          ? err.message
          : "SMTP email delivery is not configured.",
    });
  }

  // 5. Persistent private object storage configuration
  const rawDriver = (env.DOCUMENT_STORAGE_DRIVER || "").trim().toLowerCase();
  let documentStorageDriver: "s3" | "local" | "unconfigured" = "unconfigured";
  let documentUploadsEnabled = false;

  try {
    const s3Cfg = resolveS3StorageConfig(env);
    if (rawDriver === "local") {
      if (isProd) {
        documentStorageDriver = "unconfigured";
        documentUploadsEnabled = false;
        checks.push({
          category: "documentStorage",
          status: "ERROR",
          summary:
            "DOCUMENT_STORAGE_DRIVER=local is prohibited in production. Configure durable S3-compatible private storage.",
        });
      } else {
        documentStorageDriver = "local";
        documentUploadsEnabled = true;
        checks.push({
          category: "documentStorage",
          status: "OK",
          summary: "Local private development storage active (non-production).",
        });
      }
    } else if (s3Cfg) {
      documentStorageDriver = "s3";
      documentUploadsEnabled = true;
      checks.push({
        category: "documentStorage",
        status: "OK",
        summary:
          "Persistent S3-compatible private object storage configured with TLS and private access controls.",
      });
    } else if (isProd || rawDriver === "s3") {
      documentStorageDriver = "unconfigured";
      documentUploadsEnabled = false;
      checks.push({
        category: "documentStorage",
        status: "ERROR",
        summary:
          "Persistent private object storage (S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY) is not configured; production uploads are disabled safely.",
      });
    } else {
      documentStorageDriver = "local";
      documentUploadsEnabled = true;
      checks.push({
        category: "documentStorage",
        status: "WARN",
        summary:
          "Using local private storage in development; configure S3-compatible object storage before production deployment.",
      });
    }
  } catch (err) {
    documentStorageDriver = "unconfigured";
    documentUploadsEnabled = false;
    checks.push({
      category: "documentStorage",
      status: "ERROR",
      summary:
        err instanceof Error
          ? err.message
          : "Document object storage configuration is invalid.",
    });
  }

  // 6. Malware scanner configuration (ClamAV)
  const clamCheck = validateClamAvConfiguration(env);
  const scannerConfigured = clamCheck.configured && clamCheck.valid;
  if (scannerConfigured) {
    checks.push({
      category: "malwareScanner",
      status: "OK",
      summary: "ClamAV INSTREAM malware scanning backend is configured.",
    });
  } else if (clamCheck.configured && !clamCheck.valid) {
    checks.push({
      category: "malwareScanner",
      status: "ERROR",
      summary:
        clamCheck.reason || "ClamAV malware scanner configuration is invalid.",
    });
  } else {
    checks.push({
      category: "malwareScanner",
      status: isProd ? "ERROR" : "WARN",
      summary:
        "ClamAV malware scanning service (CLAMAV_HOST / CLAMAV_PORT) is not configured; documents remain PENDING and cannot be approved.",
    });
  }

  // 7. Public app URL & trusted origin settings
  const appUrl = env.NEXT_PUBLIC_APP_URL?.trim();
  if (!appUrl) {
    checks.push({
      category: "appUrl",
      status: isProd ? "ERROR" : "WARN",
      summary: "NEXT_PUBLIC_APP_URL is not configured.",
    });
  } else {
    try {
      const parsedAppUrl = new URL(appUrl);
      if (isProd && parsedAppUrl.protocol !== "https:") {
        checks.push({
          category: "appUrl",
          status: "ERROR",
          summary: "Production NEXT_PUBLIC_APP_URL must use HTTPS.",
        });
      } else {
        checks.push({
          category: "appUrl",
          status: "OK",
          summary: "Application URL and CSRF origin host validated.",
        });
      }
    } catch {
      checks.push({
        category: "appUrl",
        status: "ERROR",
        summary: "NEXT_PUBLIC_APP_URL is not a valid URL.",
      });
    }
  }

  // 8. Distributed rate limiter backend
  const hasRedis = Boolean(
    env.UPSTASH_REDIS_REST_URL?.trim() && env.UPSTASH_REDIS_REST_TOKEN?.trim()
  );
  checks.push({
    category: "rateLimiter",
    status: "OK",
    summary: hasRedis
      ? "Upstash Redis atomic Lua EVAL rate limiter configured."
      : "PostgreSQL atomic SQL upsert rate limiter active.",
  });

  const hasErrors = checks.some((c) => c.status === "ERROR");

  return {
    environment,
    productionReady:
      !hasErrors &&
      documentStorageDriver === "s3" &&
      documentUploadsEnabled &&
      scannerConfigured,
    documentStorageDriver,
    documentUploadsEnabled,
    scannerConfigured,
    checks,
  };
}
