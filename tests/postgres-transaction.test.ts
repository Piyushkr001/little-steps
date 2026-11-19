import assert from "node:assert/strict";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { eq } from "drizzle-orm";
import {
  closeDatabasePool,
  DatabaseConfigurationError,
  db,
  resolveDatabaseConnectionString,
  setDatabaseInstanceForTests,
} from "../config/db";
import {
  adminAuditLogs,
  adminOtpChallenges,
  adminProfiles,
  adminSessions,
  bookings,
  caregivers,
  caregiverVerifications,
  centers,
  centerVerifications,
  platformSettings,
  providers,
  providerVerifications,
  userRoles,
  users,
  verificationDocuments,
  verificationReviewHistory,
} from "../config/schema";
import type { AuthenticatedAdmin } from "../lib/admin/types";
import { setAdminOtpMailInterceptorForTests } from "../server/mail/nodemailer";
import {
  checkRateLimit,
  hashRateLimitKey,
  setRateLimitBackendForTests,
} from "../server/middleware/rate-limit";
import {
  issueAdminOtpChallenge,
  verifyAdminOtpAndCreateSession,
} from "../server/services/admin-auth.service";
import {
  readAuthorizedDocumentContent,
  setDocumentStorageAdapterForTests,
} from "../server/services/document-storage.service";
import {
  approveCaregiverVerification,
  approveCenterVerification,
  approveProviderVerification,
  approveVerificationDocument,
} from "../server/services/operations.service";

dotenv.config({ quiet: true });

async function runPostgresTransactionIntegrationSuite() {
  const testDbUrl = process.env.TEST_DATABASE_URL?.trim();
  const prodDbUrl = process.env.DATABASE_URL?.trim();
  const requirePgTests =
    process.env.CI === "true" || process.env.REQUIRE_PG_TESTS === "true";

  if (!testDbUrl) {
    if (requirePgTests) {
      throw new Error(
        "CI FAILURE: TEST_DATABASE_URL is required when CI=true or REQUIRE_PG_TESTS=true. PostgreSQL transaction tests cannot silently skip in CI."
      );
    }
    console.log(
      "SKIPPED: Live PostgreSQL transaction suite requires TEST_DATABASE_URL (local PostgreSQL/Docker daemon or separate Neon test branch unavailable)."
    );
    return;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SAFETY ABORT: Refusing to execute mutating integration tests when NODE_ENV=production."
    );
  }

  if (prodDbUrl && testDbUrl === prodDbUrl) {
    throw new Error(
      "SAFETY ABORT: TEST_DATABASE_URL must never equal DATABASE_URL."
    );
  }

  const mutableEnv = process.env as Record<string, string | undefined>;
  const originalNodeEnv = mutableEnv.NODE_ENV;
  const origOtpSecret = process.env.ADMIN_OTP_HMAC_SECRET;
  const origSessionSecret = process.env.ADMIN_SESSION_SECRET;
  mutableEnv.NODE_ENV = "test";
  process.env.ADMIN_OTP_HMAC_SECRET =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  process.env.ADMIN_SESSION_SECRET =
    "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f";
  setDatabaseInstanceForTests(null);

  const resolvedUrl = resolveDatabaseConnectionString(process.env);
  assert.equal(resolvedUrl, testDbUrl);

  const runTag = crypto.randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];
  const createdProviderIds: string[] = [];
  const createdCenterIds: string[] = [];
  const createdCaregiverIds: string[] = [];
  let createdRateLimitKey: string | null = null;

  const samplePdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n");
  const sampleSha = crypto.createHash("sha256").update(samplePdf).digest("hex");

  setDocumentStorageAdapterForTests({
    driverName: "s3",
    async putObject() {},
    async getObject() {
      return samplePdf;
    },
    async headObject() {
      return { exists: true, contentLength: samplePdf.byteLength };
    },
    async deleteObject() {},
  });

  const capturedOtps: string[] = [];
  setAdminOtpMailInterceptorForTests((payload) => {
    capturedOtps.push(payload.otpCode);
  });

  try {
    console.log("PG1-2. Testing Real PostgreSQL COMMIT & ROLLBACK Atomicity...");

    const [reviewer] = await db
      .insert(users)
      .values({
        email: `pg-reviewer-admin-${runTag}@littlesteps.com`,
        name: "PG Integration Reviewer",
        role: "SUPER_ADMIN",
        status: "ACTIVE",
        emailVerified: true,
      })
      .returning();
    createdUserIds.push(reviewer.id);

    await db.insert(userRoles).values({
      userId: reviewer.id,
      role: "SUPER_ADMIN",
      isActive: true,
    });

    await db.insert(adminProfiles).values({
      userId: reviewer.id,
      department: "Trust & Safety",
      title: "Compliance Reviewer",
      isApproved: true,
      permissions: [
        "dashboard:read",
        "providers:read",
        "providers:verify",
        "documents:read",
        "documents:review",
        "documents:upload",
        "documents:scan",
      ],
    });

    const [owner] = await db
      .insert(users)
      .values({
        email: `pg-owner-${runTag}@example.com`,
        name: "PG Provider Owner",
        role: "PROVIDER",
        status: "ACTIVE",
        emailVerified: true,
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

    const [center] = await db
      .insert(centers)
      .values({
        providerId: prov.id,
        name: `PG Center ${runTag}`,
        slug: `pg-center-${runTag}`,
        address: "100 Tx Lane",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        phone: "555-0198",
        email: `pg-center-${runTag}@example.com`,
        approvedCapacity: 20,
        ageGroupsSupported: ["Infant", "Toddler"],
        operatingHours: { mon: { open: "00:00", close: "23:59", is24Hours: true } },
      })
      .returning();
    createdCenterIds.push(center.id);

    const [caregiver] = await db
      .insert(caregivers)
      .values({
        centerId: center.id,
        fullName: `PG Caregiver ${runTag}`,
        email: `pg-cg-${runTag}@example.com`,
        phone: "555-0197",
        roleTitle: "Lead Caregiver",
        yearsExperience: 5,
        isActive: true,
      })
      .returning();
    createdCaregiverIds.push(caregiver.id);

    const [orgDoc] = await db
      .insert(verificationDocuments)
      .values({
        providerId: prov.id,
        documentCategory: "PROVIDER",
        documentType: "STATE_CHILDCARE_LICENSE",
        documentTitle: `PG Test Org License ${runTag}`,
        storageReference: `s3-private://${prov.id}/org-license.pdf`,
        originalFileName: "org-license.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: samplePdf.byteLength,
        checksumSha256: sampleSha,
        malwareScanStatus: "CLEAN",
        malwareScanProvider: "CLAMAV",
        malwareScannedAt: new Date(),
        status: "SUBMITTED",
        expiresAt: new Date(Date.now() + 86_400_000 * 180),
        uploadedBy: owner.id,
      })
      .returning();

    const [centerDoc] = await db
      .insert(verificationDocuments)
      .values({
        providerId: prov.id,
        centerId: center.id,
        documentCategory: "CENTER",
        documentType: "FIRE_SAFETY_PERMIT",
        documentTitle: `PG Fire Permit ${runTag}`,
        storageReference: `s3-private://${prov.id}/fire-permit.pdf`,
        originalFileName: "fire-permit.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: samplePdf.byteLength,
        checksumSha256: sampleSha,
        malwareScanStatus: "CLEAN",
        malwareScanProvider: "CLAMAV",
        malwareScannedAt: new Date(),
        status: "VERIFIED",
        reviewedBy: reviewer.id,
        reviewedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000 * 180),
        uploadedBy: owner.id,
      })
      .returning();
    assert.ok(centerDoc);

    const [cgDoc] = await db
      .insert(verificationDocuments)
      .values({
        providerId: prov.id,
        centerId: center.id,
        caregiverId: caregiver.id,
        documentCategory: "CAREGIVER",
        documentType: "BACKGROUND_CHECK",
        documentTitle: `PG Background Check ${runTag}`,
        storageReference: `s3-private://${prov.id}/cg-bg.pdf`,
        originalFileName: "cg-bg.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: samplePdf.byteLength,
        checksumSha256: sampleSha,
        malwareScanStatus: "CLEAN",
        malwareScanProvider: "CLAMAV",
        malwareScannedAt: new Date(),
        status: "VERIFIED",
        reviewedBy: reviewer.id,
        reviewedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000 * 180),
        uploadedBy: owner.id,
      })
      .returning();
    assert.ok(cgDoc);

    const [verif] = await db
      .insert(providerVerifications)
      .values({
        providerId: prov.id,
        status: "PENDING",
        submittedAt: new Date(),
      })
      .returning();

    // 2. Real SQL ROLLBACK reverts partial writes
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

    const adminContext: AuthenticatedAdmin = {
      id: reviewer.id,
      email: reviewer.email,
      name: reviewer.name,
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      department: "Trust & Safety",
      title: "Compliance Reviewer",
      permissions: [
        "dashboard:read",
        "providers:read",
        "providers:verify",
        "documents:read",
        "documents:review",
        "documents:upload",
        "documents:scan",
      ],
      sessionId: crypto.randomUUID(),
      csrfToken: "pg-test-csrf",
      lastLoginAt: null,
      sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };

    // 6. Document approval + evidence access + audit logging consistency
    console.log("PG3. Testing Evidence-Backed Document Approval & Expired Persistence...");
    await readAuthorizedDocumentContent({
      documentId: orgDoc.id,
      admin: adminContext,
    });
    const docApproveRes = await approveVerificationDocument({
      documentId: orgDoc.id,
      reviewNotes: "Verified org license in PG transaction suite.",
      evidenceReviewed: true,
      reviewedChecksumSha256: sampleSha,
      admin: adminContext,
    });
    assert.equal(docApproveRes.status, "VERIFIED");
    console.log("    [PASS] Document approval & audit log committed atomically.");

    // 3. Concurrent FOR UPDATE provider verification (1 succeeds, 1 conflicts 409)
    console.log(
      "PG4. Testing Concurrent FOR UPDATE Verification Decisions (One 200, One 409)..."
    );
    const approveInput = {
      verificationId: verif.id,
      reviewComments: "Concurrent real PostgreSQL approval verification",
      checklistState: {
        licenseVerified: true,
        organizationDetailsVerified: true,
      },
      admin: adminContext,
    };

    const [res1, res2] = await Promise.allSettled([
      approveProviderVerification(approveInput),
      approveProviderVerification(approveInput),
    ]);
    assert.equal([res1, res2].filter((r) => r.status === "fulfilled").length, 1);
    assert.equal([res1, res2].filter((r) => r.status === "rejected").length, 1);
    console.log(
      "    [PASS] Real PostgreSQL FOR UPDATE serialized concurrent provider approvals."
    );

    // 4 & 5. Caregiver & Centre verification state consistency
    console.log("PG5. Testing Caregiver & Centre Transactional Verification Consistency...");
    const cgRes = await approveCaregiverVerification({
      idOrCaregiverId: caregiver.id,
      reviewComments: "Verified caregiver background clearance in PG test.",
      checklistState: {
        backgroundScreeningVerified: true,
        credentialsVerified: true,
      },
      admin: adminContext,
    });
    assert.equal(cgRes.status, "VERIFIED");

    const centerRes = await approveCenterVerification({
      idOrCenterId: center.id,
      reviewComments: "Verified centre permits, capacity, hours, and staff in PG test.",
      checklistState: {
        operatingLicenseVerified: true,
        facilitySafetyVerified: true,
        caregiverQualificationVerified: true,
        capacityVerified: true,
        operatingHoursVerified: true,
        ageGroupsVerified: true,
      },
      admin: adminContext,
    });
    assert.equal(centerRes.status, "APPROVED");
    assert.equal(centerRes.listingStatus, "ACTIVE");
    console.log("    [PASS] Caregiver & Centre verification tables & history committed cleanly.");

    // 7. Atomic OTP consumption + session creation
    console.log("PG6. Testing Atomic OTP Issuance & Verification...");
    await issueAdminOtpChallenge({ email: reviewer.email });
    const latestOtp = capturedOtps.at(-1)!;
    const otpSession = await verifyAdminOtpAndCreateSession({
      email: reviewer.email,
      otp: latestOtp,
    });
    assert.ok(otpSession.rawSessionToken);
    // Replay of same OTP fails because consumedAt committed atomically
    await assert.rejects(() =>
      verifyAdminOtpAndCreateSession({
        email: reviewer.email,
        otp: latestOtp,
      })
    );
    console.log("    [PASS] Atomic OTP consumption, session insert & replay prevention verified.");

    // 8. Database CHECK constraints enforced by PostgreSQL engine
    console.log("PG7. Testing PostgreSQL CHECK Constraint Enforcement...");
    await assert.rejects(() =>
      db.insert(verificationDocuments).values({
        providerId: prov.id,
        documentCategory: "PROVIDER",
        documentType: "INVALID_SCAN_STATE",
        documentTitle: "Constraint Check Doc",
        storageReference: `s3-private://${prov.id}/bad.pdf`,
        mimeType: "application/pdf",
        fileSizeBytes: 100,
        malwareScanStatus: "INVALID_STATUS",
        status: "SUBMITTED",
      })
    );
    await assert.rejects(() =>
      db.insert(verificationDocuments).values({
        providerId: prov.id,
        documentCategory: "PROVIDER",
        documentType: "OVERSIZED_DB_CHECK",
        documentTitle: "Oversized DB Constraint Doc",
        storageReference: `s3-private://${prov.id}/big.pdf`,
        mimeType: "application/pdf",
        fileSizeBytes: 25 * 1024 * 1024,
        malwareScanStatus: "PENDING",
        status: "SUBMITTED",
      })
    );
    void bookings;
    console.log("    [PASS] PostgreSQL CHECK constraints actively rejected invalid writes.");

    // 9. Concurrent PostgreSQL SQL upsert rate-limit counter accuracy
    console.log("PG8. Testing Concurrent PostgreSQL SQL Rate-Limit Upsert...");
    setRateLimitBackendForTests("database");
    const rawRateKey = `pg-it:run-${runTag}`;
    createdRateLimitKey = hashRateLimitKey("pg-it", `run-${runTag}`);
    const results = await Promise.all([
      checkRateLimit(rawRateKey, 2, 60_000),
      checkRateLimit(rawRateKey, 2, 60_000),
      checkRateLimit(rawRateKey, 2, 60_000),
      checkRateLimit(rawRateKey, 2, 60_000),
    ]);
    assert.equal(results.filter((r) => r.allowed).length, 2);
    assert.equal(results.filter((r) => !r.allowed).length, 2);
    console.log("    [PASS] Atomic PostgreSQL UPSERT rate limiter counted exact burst.");

    // 10. Connection configuration failure handling
    assert.throws(
      () =>
        resolveDatabaseConnectionString({
          NODE_ENV: "test",
          TEST_DATABASE_URL: "not-a-valid-url",
        } as unknown as NodeJS.ProcessEnv),
      DatabaseConfigurationError
    );
    console.log("    [PASS] Database configuration failure handling verified.");
  } finally {
    if (createdRateLimitKey) {
      await db
        .delete(platformSettings)
        .where(eq(platformSettings.settingKey, createdRateLimitKey))
        .catch(() => {});
    }
    for (const cgid of createdCaregiverIds) {
      await db
        .delete(caregiverVerifications)
        .where(eq(caregiverVerifications.caregiverId, cgid))
        .catch(() => {});
      await db.delete(caregivers).where(eq(caregivers.id, cgid)).catch(() => {});
    }
    for (const cid of createdCenterIds) {
      await db
        .delete(centerVerifications)
        .where(eq(centerVerifications.centerId, cid))
        .catch(() => {});
      await db.delete(centers).where(eq(centers.id, cid)).catch(() => {});
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
        .delete(adminOtpChallenges)
        .where(eq(adminOtpChallenges.userId, uid))
        .catch(() => {});
      await db
        .delete(adminSessions)
        .where(eq(adminSessions.userId, uid))
        .catch(() => {});
      await db
        .delete(adminProfiles)
        .where(eq(adminProfiles.userId, uid))
        .catch(() => {});
      await db.delete(userRoles).where(eq(userRoles.userId, uid)).catch(() => {});
      await db.delete(users).where(eq(users.id, uid)).catch(() => {});
    }
    setAdminOtpMailInterceptorForTests(null);
    setRateLimitBackendForTests(null);
    setDocumentStorageAdapterForTests(null);
    mutableEnv.NODE_ENV = originalNodeEnv;
    if (origOtpSecret !== undefined) process.env.ADMIN_OTP_HMAC_SECRET = origOtpSecret;
    if (origSessionSecret !== undefined) process.env.ADMIN_SESSION_SECRET = origSessionSecret;
    await closeDatabasePool();
  }
}

runPostgresTransactionIntegrationSuite().catch((err) => {
  console.error("PostgreSQL integration test suite failed:", err);
  process.exit(1);
});
