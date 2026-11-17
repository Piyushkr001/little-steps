import assert from "node:assert/strict";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { eq } from "drizzle-orm";
import {
  closeDatabasePool,
  db,
  resolveDatabaseConnectionString,
  setDatabaseInstanceForTests,
} from "../config/db";
import {
  adminAuditLogs,
  adminProfiles,
  adminSessions,
  providers,
  providerVerifications,
  platformSettings,
  users,
  verificationDocuments,
  verificationReviewHistory,
} from "../config/schema";
import {
  hashRateLimitKey,
  setRateLimitBackendForTests,
  checkRateLimit,
} from "../server/middleware/rate-limit";
import { setDocumentStorageAdapterForTests } from "../server/services/document-storage.service";
import { approveProviderVerification } from "../server/services/operations.service";

dotenv.config({ quiet: true });

async function runPostgresTransactionIntegrationSuite() {
  const testDbUrl = process.env.TEST_DATABASE_URL?.trim();
  const prodDbUrl = process.env.DATABASE_URL?.trim();

  if (!testDbUrl) {
    console.log(
      "SKIPPED: Live PostgreSQL transaction suite requires TEST_DATABASE_URL (local PostgreSQL/Docker daemon or separate Neon test branch unavailable)."
    );
    return;
  }

  if (prodDbUrl && testDbUrl === prodDbUrl) {
    throw new Error(
      "SAFETY ABORT: TEST_DATABASE_URL must never equal DATABASE_URL."
    );
  }

  const mutableEnv = process.env as Record<string, string | undefined>;
  const originalNodeEnv = mutableEnv.NODE_ENV;
  mutableEnv.NODE_ENV = "test";
  setDatabaseInstanceForTests(null);

  const resolvedUrl = resolveDatabaseConnectionString(process.env);
  assert.equal(resolvedUrl, testDbUrl);

  const runTag = crypto.randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];
  const createdProviderIds: string[] = [];
  let createdRateLimitKey: string | null = null;

  const samplePdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n");
  const sampleSha = crypto.createHash("sha256").update(samplePdf).digest("hex");

  setDocumentStorageAdapterForTests({
    async putObject() {},
    async getObject() {
      return samplePdf;
    },
    async deleteObject() {},
  });

  try {
    console.log("PG1. Testing Real PostgreSQL BEGIN / ROLLBACK Atomicity...");

    const [reviewer] = await db
      .insert(users)
      .values({
        email: `pg-reviewer-${runTag}@littlesteps.com`,
        name: "PG Integration Reviewer",
        role: "ADMIN",
        status: "ACTIVE",
      })
      .returning();
    createdUserIds.push(reviewer.id);

    await db.insert(adminProfiles).values({
      userId: reviewer.id,
      isApproved: true,
      permissions: ["providers:read", "providers:verify"],
    });

    const [owner] = await db
      .insert(users)
      .values({
        email: `pg-owner-${runTag}@example.com`,
        name: "PG Provider Owner",
        role: "PROVIDER",
        status: "ACTIVE",
      })
      .returning();
    createdUserIds.push(owner.id);

    const [prov] = await db
      .insert(providers)
      .values({
        ownerUserId: owner.id,
        organizationName: `PG Tx Test Org ${runTag}`,
        registrationNumber: `PG-REG-${runTag}`,
        contactEmail: `pg-org-${runTag}@example.com`,
        contactPhone: "555-0199",
        address: "100 Tx Lane",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        verificationStatus: "PENDING",
        subscriptionActive: true,
        isPublished: false,
      })
      .returning();
    createdProviderIds.push(prov.id);

    await db.insert(verificationDocuments).values({
      providerId: prov.id,
      documentCategory: "PROVIDER",
      documentType: "STATE_CHILDCARE_LICENSE",
      documentTitle: `PG Test License ${runTag}`,
      storageReference: `private://${prov.id}/license.pdf`,
      originalFileName: "license.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: samplePdf.byteLength,
      checksumSha256: sampleSha,
      malwareScanStatus: "CLEAN",
      malwareScanProvider: "clamav-pg-test",
      malwareScannedAt: new Date(),
      status: "VERIFIED",
      reviewedBy: reviewer.id,
      reviewedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000 * 180),
      uploadedBy: owner.id,
    });

    const [verif] = await db
      .insert(providerVerifications)
      .values({
        providerId: prov.id,
        status: "PENDING",
        submittedAt: new Date(),
      })
      .returning();

    // Force an error mid-transaction after mutating provider status
    let threwRollback = false;
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(providers)
          .set({ verificationStatus: "APPROVED", isPublished: true })
          .where(eq(providers.id, prov.id));
        throw new Error("Simulated PG failure after provider update");
      });
    } catch {
      threwRollback = true;
    }
    assert.equal(threwRollback, true);

    const [provAfterRollback] = await db
      .select()
      .from(providers)
      .where(eq(providers.id, prov.id))
      .limit(1);
    assert.equal(provAfterRollback.verificationStatus, "PENDING");
    assert.equal(provAfterRollback.isPublished, false);
    console.log("    [PASS] Real PostgreSQL ROLLBACK reverted partial updates.");

    console.log(
      "PG2. Testing Concurrent FOR UPDATE Verification Decisions (One 200, One 409)..."
    );

    const adminContext = {
      id: reviewer.id,
      email: reviewer.email,
      name: reviewer.name,
      role: "ADMIN" as const,
      status: "ACTIVE" as const,
      department: "Trust & Safety",
      title: "Compliance Reviewer",
      permissions: ["providers:read", "providers:verify"] as (
        | "providers:read"
        | "providers:verify"
      )[],
      sessionId: crypto.randomUUID(),
      csrfToken: "pg-test-csrf",
      lastLoginAt: null,
      sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };

    const approveInput = {
      verificationId: verif.id,
      reviewComments: "Concurrent real PostgreSQL approval verification",
      checklistState: {
        licenseVerified: true,
        organizationDetailsVerified: true,
      },
      admin: {
        ...adminContext,
        permissions: [...adminContext.permissions],
      },
    };

    const [res1, res2] = await Promise.allSettled([
      approveProviderVerification(approveInput),
      approveProviderVerification(approveInput),
    ]);

    const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled");
    const rejected = [res1, res2].filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    console.log(
      "    [PASS] Real PostgreSQL FOR UPDATE serialized concurrent approvals cleanly."
    );

    console.log(
      "PG3. Testing Single-Statement Atomic SQL Rate-Limit Upsert..."
    );
    setRateLimitBackendForTests("database");
    const rawRateKey = `pg-it:run-${runTag}`;
    createdRateLimitKey = hashRateLimitKey("pg-it", `run-${runTag}`);
    const [r1, r2, r3] = await Promise.all([
      checkRateLimit(rawRateKey, 2, 60_000),
      checkRateLimit(rawRateKey, 2, 60_000),
      checkRateLimit(rawRateKey, 2, 60_000),
    ]);
    const allowedCount = [r1, r2, r3].filter((r) => r.allowed).length;
    assert.equal(allowedCount, 2);
    console.log("    [PASS] Atomic SQL UPSERT rate limiter verified.");
  } finally {
    if (createdRateLimitKey) {
      await db
        .delete(platformSettings)
        .where(eq(platformSettings.settingKey, createdRateLimitKey))
        .catch(() => {});
    }
    for (const pid of createdProviderIds) {
      await db
        .delete(verificationDocuments)
        .where(eq(verificationDocuments.providerId, pid))
        .catch(() => {});
      await db
        .delete(providerVerifications)
        .where(eq(providerVerifications.providerId, pid))
        .catch(() => {});
      await db.delete(providers).where(eq(providers.id, pid)).catch(() => {});
    }
    for (const uid of createdUserIds) {
      await db
        .delete(adminAuditLogs)
        .where(eq(adminAuditLogs.adminUserId, uid))
        .catch(() => {});
      await db
        .delete(verificationReviewHistory)
        .where(eq(verificationReviewHistory.reviewerId, uid))
        .catch(() => {});
      await db
        .delete(adminSessions)
        .where(eq(adminSessions.userId, uid))
        .catch(() => {});
      await db
        .delete(adminProfiles)
        .where(eq(adminProfiles.userId, uid))
        .catch(() => {});
      await db.delete(users).where(eq(users.id, uid)).catch(() => {});
    }
    setRateLimitBackendForTests(null);
    setDocumentStorageAdapterForTests(null);
    mutableEnv.NODE_ENV = originalNodeEnv;
    await closeDatabasePool();
  }
}

runPostgresTransactionIntegrationSuite().catch((err) => {
  console.error("PostgreSQL integration test suite failed:", err);
  process.exit(1);
});
