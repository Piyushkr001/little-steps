import { desc } from "drizzle-orm";
import { db, type DbClientOrTx } from "../../config/db";
import { adminAuditLogs } from "../../config/schema";
import { computeAuditIntegrityHash } from "../security/crypto";

export type AuditOutcome = "SUCCESS" | "FAILURE" | "DENIED";

export interface RecordAdminAuditInput {
  adminUserId?: string | null;
  adminEmail: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  outcome?: AuditOutcome;
  previousState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const SENSITIVE_AUDIT_KEYS = new Set([
  "otp",
  "otpcode",
  "otphash",
  "rawsessiontoken",
  "sessiontoken",
  "sessiontokenhash",
  "csrftoken",
  "secret",
  "admin_otp_hmac_secret",
  "admin_session_secret",
  "jwt_secret",
  "password",
  "smtppass",
  "smtp_pass",
  "database_url",
  "medicalnotes",
  "allergies",
  "childfullname",
  "dateofbirth",
]);

/**
 * Recursively sanitizes audit state objects so plaintext OTPs, secrets,
 * session tokens, and sensitive child medical/PII fields are never persisted.
 */
export function sanitizeAuditState(
  input: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, "");
    if (SENSITIVE_AUDIT_KEYS.has(normalizedKey)) {
      continue;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      sanitized[key] = sanitizeAuditState(value as Record<string, unknown>);
    } else if (typeof value === "string") {
      sanitized[key] = value.replace(
        /postgres(?:ql)?:\/\/[^\s"']+/gi,
        "[REDACTED_DB_URI]"
      );
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

function inferDefaultOutcome(action: string): AuditOutcome {
  const upper = action.toUpperCase();
  if (
    upper.includes("DENIED") ||
    upper.includes("UNAUTHORIZED") ||
    upper.includes("FORBIDDEN")
  ) {
    return "DENIED";
  }
  if (upper.includes("FAILED") || upper.includes("ERROR")) {
    return "FAILURE";
  }
  return "SUCCESS";
}

export async function recordAdminAuditLog(
  input: RecordAdminAuditInput,
  executor: DbClientOrTx = db
) {
  const now = new Date();
  const timestampIso = now.toISOString();
  const outcome = input.outcome ?? inferDefaultOutcome(input.action);

  const safeSummary = input.summary.replace(
    /postgres(?:ql)?:\/\/[^\s"']+/gi,
    "[REDACTED_DB_URI]"
  );

  const sanitizedPrev = sanitizeAuditState(input.previousState);
  const sanitizedNext = sanitizeAuditState({
    ...(input.newState ?? {}),
    outcome,
  });

  const integrityHash = computeAuditIntegrityHash({
    adminEmail: input.adminEmail,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    summary: safeSummary,
    timestampIso,
  });

  const [created] = await executor
    .insert(adminAuditLogs)
    .values({
      adminUserId: input.adminUserId ?? null,
      adminEmail: input.adminEmail,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      summary: safeSummary,
      previousState: sanitizedPrev,
      newState: sanitizedNext,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      integrityHash,
      createdAt: now,
    })
    .returning();

  return created;
}

export async function listRecentAdminAuditLogs(limit = 50) {
  return db
    .select()
    .from(adminAuditLogs)
    .orderBy(desc(adminAuditLogs.createdAt))
    .limit(limit);
}
