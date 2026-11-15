import { desc } from "drizzle-orm";
import { db } from "@/config/db";
import { adminAuditLogs } from "@/config/schema";
import { computeAuditIntegrityHash } from "../security/crypto";

export interface RecordAdminAuditInput {
  adminUserId?: string | null;
  adminEmail: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  previousState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function recordAdminAuditLog(input: RecordAdminAuditInput) {
  const now = new Date();
  const timestampIso = now.toISOString();

  const integrityHash = computeAuditIntegrityHash({
    adminEmail: input.adminEmail,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    summary: input.summary,
    timestampIso,
  });

  const [created] = await db
    .insert(adminAuditLogs)
    .values({
      adminUserId: input.adminUserId ?? null,
      adminEmail: input.adminEmail,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      summary: input.summary,
      previousState: input.previousState ?? undefined,
      newState: input.newState ?? undefined,
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
