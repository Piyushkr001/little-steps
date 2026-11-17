import assert from "node:assert/strict";
import crypto from "node:crypto";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import {
  type AppDatabase,
  DatabaseConfigurationError,
  resolveDatabaseConnectionString,
  setDatabaseInstanceForTests,
} from "../config/db";
import {
  adminAuditLogs,
  adminOtpChallenges,
  adminProfiles,
  adminSessions,
  bookings,
  bookingStatusHistory,
  capacityRules,
  caregivers,
  caregiverVerifications,
  centers,
  centerVerifications,
  children,
  disputes,
  incidentActivity,
  notifications,
  platformSettings,
  providers,
  providerVerifications,
  safetyIncidents,
  userRoles,
  users,
  verificationDocuments,
  verificationReviewHistory,
} from "../config/schema";
import {
  type CookieInstruction,
  dispatchAdminApiRequest,
  handleDocumentContentStreamRequest,
} from "../server/dispatcher";
import { setAdminOtpMailInterceptorForTests } from "../server/mail/nodemailer";
import {
  checkRateLimit,
  getActiveKeyLockCountForTests,
  resetAllRateLimitsForTests,
  setRateLimitBackendForTests,
} from "../server/middleware/rate-limit";
import {
  setDocumentScannerForTests,
} from "../server/services/document-scanner.service";
import {
  setDocumentStorageAdapterForTests,
} from "../server/services/document-storage.service";
import {
  inspectHistoricalCleanDocumentsImpact,
  isCenterScopedDocument,
  isProviderScopedDocument,
} from "../server/services/operations.service";
import {
  ADMIN_CSRF_COOKIE_NAME,
  ADMIN_CSRF_HEADER_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  AdminCryptoSecretError,
  hashOtp,
  hashSessionToken,
  validateCryptographicSecret,
  verifyAuditIntegrityHash,
  verifyOtpHash,
} from "../server/security/crypto";
import {
  hasAdminPermission,
  resolveEffectiveAdminPermissions,
} from "../server/security/permissions";

// ============================================================================
// Isolated In-Memory Drizzle Test Database Harness
// Ensures tests NEVER connect to or mutate the live Neon PostgreSQL database.
// ============================================================================

type RowRecord = Record<string, unknown>;

function buildColumnMap(table: object): Map<string, string> {
  const map = new Map<string, string>();
  for (const [jsKey, val] of Object.entries(table)) {
    if (
      val &&
      typeof val === "object" &&
      "name" in val &&
      typeof (val as { name?: unknown }).name === "string"
    ) {
      map.set((val as { name: string }).name, jsKey);
    }
  }
  return map;
}

const pgDialect = new PgDialect();

function evaluateWhereCondition(
  row: RowRecord,
  table: object,
  whereExpr: unknown
): boolean {
  if (!whereExpr) return true;
  const colMap = buildColumnMap(table);
  const { sql: rawSql, params } = pgDialect.sqlToQuery(
    whereExpr as Parameters<typeof pgDialect.sqlToQuery>[0]
  );

  const clauses = rawSql.trim().split(/\s+and\s+/i);
  for (let clause of clauses) {
    clause = clause.trim();
    while (clause.startsWith("(")) {
      clause = clause.slice(1).trim();
    }
    if (/\s+in\s+\(/i.test(clause)) {
      const inCloseIdx = clause.indexOf(")");
      if (inCloseIdx !== -1) {
        clause = clause.slice(0, inCloseIdx + 1).trim();
      }
    } else {
      while (clause.endsWith(")")) {
        clause = clause.slice(0, -1).trim();
      }
    }

    const isNullMatch = clause.match(/^"[^"]+"\."([^"]+)"\s+is\s+null$/i);
    if (isNullMatch) {
      const jsKey = colMap.get(isNullMatch[1]) ?? isNullMatch[1];
      if (row[jsKey] !== null && row[jsKey] !== undefined) return false;
      continue;
    }

    const eqMatch = clause.match(/^"[^"]+"\."([^"]+)"\s*=\s*\$(\d+)$/i);
    if (eqMatch) {
      const jsKey = colMap.get(eqMatch[1]) ?? eqMatch[1];
      const expected = params[Number(eqMatch[2]) - 1];
      if (row[jsKey] !== expected) return false;
      continue;
    }

    const neMatch = clause.match(/^"[^"]+"\."([^"]+)"\s*(?:<>|!=)\s*\$(\d+)$/i);
    if (neMatch) {
      const jsKey = colMap.get(neMatch[1]) ?? neMatch[1];
      const disallowed = params[Number(neMatch[2]) - 1];
      if (row[jsKey] === disallowed) return false;
      continue;
    }

    const gtMatch = clause.match(/^"[^"]+"\."([^"]+)"\s*>\s*\$(\d+)$/i);
    if (gtMatch) {
      const jsKey = colMap.get(gtMatch[1]) ?? gtMatch[1];
      const left = row[jsKey];
      const right = params[Number(gtMatch[2]) - 1];
      const leftVal = left instanceof Date ? left.getTime() : Number(left);
      const rightVal =
        right instanceof Date
          ? right.getTime()
          : typeof right === "string" && !Number.isNaN(Date.parse(right))
            ? Date.parse(right)
            : Number(right);
      if (!(leftVal > rightVal)) return false;
      continue;
    }

    const ltMatch = clause.match(/^"[^"]+"\."([^"]+)"\s*<\s*\$(\d+)$/i);
    if (ltMatch) {
      const jsKey = colMap.get(ltMatch[1]) ?? ltMatch[1];
      const left = row[jsKey];
      const right = params[Number(ltMatch[2]) - 1];
      const leftVal = left instanceof Date ? left.getTime() : Number(left);
      const rightVal =
        right instanceof Date
          ? right.getTime()
          : typeof right === "string" && !Number.isNaN(Date.parse(right))
            ? Date.parse(right)
            : Number(right);
      if (!(leftVal < rightVal)) return false;
      continue;
    }

    const inMatch = clause.match(/^"[^"]+"\."([^"]+)"\s+in\s+\(([^)]+)\)$/i);
    if (inMatch) {
      const jsKey = colMap.get(inMatch[1]) ?? inMatch[1];
      const indices = inMatch[2]
        .split(",")
        .map((s) => Number(s.trim().replace("$", "")) - 1);
      const allowed = indices.map((idx) => params[idx]);
      if (!allowed.includes(row[jsKey])) return false;
      continue;
    }
  }

  return true;
}

function createIsolatedMemoryDatabase() {
  const tables = new Map<object, RowRecord[]>([
    [users, []],
    [userRoles, []],
    [adminProfiles, []],
    [adminOtpChallenges, []],
    [adminSessions, []],
    [providers, []],
    [centers, []],
    [caregivers, []],
    [verificationDocuments, []],
    [providerVerifications, []],
    [centerVerifications, []],
    [caregiverVerifications, []],
    [verificationReviewHistory, []],
    [children, []],
    [bookings, []],
    [bookingStatusHistory, []],
    [capacityRules, []],
    [safetyIncidents, []],
    [incidentActivity, []],
    [disputes, []],
    [notifications, []],
    [adminAuditLogs, []],
    [platformSettings, []],
  ]);

  let insertSeq = 0;
  let failNextInsertOnTable: object | null = null;

  const getRows = (table: object): RowRecord[] => {
    let list = tables.get(table);
    if (!list) {
      list = [];
      tables.set(table, list);
    }
    return list;
  };

  const mockDb = {
    select(projection?: Record<string, unknown>) {
      let targetTable: object | null = null;
      let whereClause: unknown = null;
      let limitCount: number | null = null;
      let hasOrderByDesc = false;

      const execute = async () => {
        if (!targetTable) return [];
        let rows = [...getRows(targetTable)].filter((r) =>
          evaluateWhereCondition(r, targetTable!, whereClause)
        );
        if (hasOrderByDesc) {
          rows.sort((a, b) => {
            const ta =
              (a.createdAt instanceof Date
                ? a.createdAt.getTime()
                : a.submittedAt instanceof Date
                  ? a.submittedAt.getTime()
                  : 0) || 0;
            const tb =
              (b.createdAt instanceof Date
                ? b.createdAt.getTime()
                : b.submittedAt instanceof Date
                  ? b.submittedAt.getTime()
                  : 0) || 0;
            if (tb !== ta) return tb - ta;
            return Number(b._seq ?? 0) - Number(a._seq ?? 0);
          });
        }
        if (limitCount !== null) {
          rows = rows.slice(0, limitCount);
        }
        if (!projection) {
          return rows.map((r) => ({ ...r }));
        }
        return rows.map((r) => {
          const projected: RowRecord = {};
          for (const key of Object.keys(projection)) {
            projected[key] = r[key];
          }
          return projected;
        });
      };

      const builder = {
        from(table: object) {
          targetTable = table;
          return builder;
        },
        where(cond: unknown) {
          whereClause = cond;
          return builder;
        },
        orderBy() {
          hasOrderByDesc = true;
          return builder;
        },
        limit(n: number) {
          limitCount = n;
          return builder;
        },
        for() {
          return builder;
        },
        then<TResult1 = RowRecord[], TResult2 = never>(
          onfulfilled?:
            | ((value: RowRecord[]) => TResult1 | PromiseLike<TResult1>)
            | null,
          onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null
        ) {
          return execute().then(onfulfilled, onrejected);
        },
      };

      return builder;
    },

    insert(table: object) {
      return {
        values(rawValues: RowRecord | RowRecord[]) {
          if (failNextInsertOnTable === table) {
            failNextInsertOnTable = null;
            const err = new Error(
              "Simulated database write failure inside transaction"
            );
            return {
              returning() {
                return Promise.reject(err);
              },
              then<TResult1 = RowRecord[], TResult2 = never>(
                _onfulfilled?:
                  | ((value: RowRecord[]) => TResult1 | PromiseLike<TResult1>)
                  | null,
                onrejected?:
                  | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
                  | null
              ) {
                return Promise.reject(err).then(undefined, onrejected);
              },
            };
          }
          const items = Array.isArray(rawValues) ? rawValues : [rawValues];
          const inserted: RowRecord[] = [];
          const tableRows = getRows(table);
          const now = new Date();

          for (const item of items) {
            insertSeq += 1;
            const record: RowRecord = {
              _seq: insertSeq,
              id: (item.id as string) || crypto.randomUUID(),
              createdAt: (item.createdAt as Date) || now,
              updatedAt: (item.updatedAt as Date) || now,
              submittedAt: (item.submittedAt as Date) || now,
              consumedAt: item.consumedAt ?? null,
              invalidatedAt: item.invalidatedAt ?? null,
              revokedAt: item.revokedAt ?? null,
              quarantinedAt: item.quarantinedAt ?? null,
              attempts: item.attempts ?? 0,
              maxAttempts: item.maxAttempts ?? 5,
              resendCount: item.resendCount ?? 0,
              ...item,
            };
            tableRows.push(record);
            inserted.push({ ...record });
          }

          return {
            returning() {
              return Promise.resolve(inserted);
            },
            then<TResult1 = RowRecord[], TResult2 = never>(
              onfulfilled?:
                | ((value: RowRecord[]) => TResult1 | PromiseLike<TResult1>)
                | null,
              onrejected?:
                | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
                | null
            ) {
              return Promise.resolve(inserted).then(onfulfilled, onrejected);
            },
          };
        },
      };
    },

    update(table: object) {
      return {
        set(updates: RowRecord) {
          let whereClause: unknown = null;

          const applyUpdate = () => {
            const tableRows = getRows(table);
            const matched: RowRecord[] = [];
            for (const row of tableRows) {
              if (evaluateWhereCondition(row, table, whereClause)) {
                for (const [k, v] of Object.entries(updates)) {
                  if (
                    v &&
                    typeof v === "object" &&
                    !(v instanceof Date) &&
                    !Array.isArray(v) &&
                    ("queryChunks" in v || v.constructor?.name === "SQL")
                  ) {
                    if (k === "attempts") {
                      row.attempts = Number(row.attempts ?? 0) + 1;
                    } else if (k === "invalidatedAt") {
                      const nextAttempts = Number(row.attempts ?? 0);
                      const maxAttempts = Number(row.maxAttempts ?? 5);
                      if (nextAttempts >= maxAttempts) {
                        row.invalidatedAt = new Date();
                      }
                    }
                  } else {
                    row[k] = v;
                  }
                }
                matched.push({ ...row });
              }
            }
            return matched;
          };

          const updateBuilder = {
            where(cond: unknown) {
              whereClause = cond;
              const updatedRows = applyUpdate();
              return {
                returning() {
                  return Promise.resolve(updatedRows);
                },
                then<TResult1 = RowRecord[], TResult2 = never>(
                  onfulfilled?:
                    | ((
                        value: RowRecord[]
                      ) => TResult1 | PromiseLike<TResult1>)
                    | null,
                  onrejected?:
                    | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
                    | null
                ) {
                  return Promise.resolve(updatedRows).then(
                    onfulfilled,
                    onrejected
                  );
                },
              };
            },
          };

          return updateBuilder;
        },
      };
    },

    delete(table: object) {
      return {
        where(cond: unknown) {
          const tableRows = getRows(table);
          const remaining = tableRows.filter(
            (r) => !evaluateWhereCondition(r, table, cond)
          );
          tables.set(table, remaining);
          return Promise.resolve();
        },
      };
    },

    async transaction<T>(fn: (tx: AppDatabase) => Promise<T>): Promise<T> {
      const snapshot = new Map<object, RowRecord[]>();
      for (const [tbl, rows] of tables.entries()) {
        snapshot.set(
          tbl,
          rows.map((r) => structuredClone(r))
        );
      }
      try {
        return await fn(mockDb as unknown as AppDatabase);
      } catch (err) {
        for (const [tbl, clonedRows] of snapshot.entries()) {
          tables.set(tbl, clonedRows);
        }
        throw err;
      }
    },

    async execute() {
      return { rows: [] };
    },
  };

  return {
    db: mockDb as unknown as AppDatabase,
    tables,
    setFailNextInsertOnTable(tbl: object | null) {
      failNextInsertOnTable = tbl;
    },
  };
}

async function seedIsolatedTestFixtures(db: AppDatabase) {
  const now = new Date();

  const [superAdmin, standardAdmin, restrictedAdmin, unapprovedAdmin, suspendedAdmin, parentWithAdminKeyword] =
    await db
      .insert(users)
      .values([
        {
          email: "superadmin@littlesteps.com",
          name: "Aarav Mehta (Super Admin)",
          role: "SUPER_ADMIN",
          status: "ACTIVE",
          emailVerified: true,
        },
        {
          email: "admin@littlesteps.com",
          name: "Priya Sharma (Operations Admin)",
          role: "ADMIN",
          status: "ACTIVE",
          emailVerified: true,
        },
        {
          email: "readonly.admin@littlesteps.com",
          name: "Read-Only Auditor Admin",
          role: "ADMIN",
          status: "ACTIVE",
          emailVerified: true,
        },
        {
          email: "unapproved.admin@littlesteps.com",
          name: "Unapproved Admin Candidate",
          role: "ADMIN",
          status: "ACTIVE",
          emailVerified: true,
        },
        {
          email: "suspended.admin@littlesteps.com",
          name: "Suspended Administrator",
          role: "ADMIN",
          status: "SUSPENDED",
          emailVerified: true,
          suspendedReason: "Security compliance hold",
        },
        {
          email: "parent.admin@example.com",
          name: "Neha Kapoor (Parent)",
          role: "PARENT",
          status: "ACTIVE",
          emailVerified: true,
        },
      ])
      .returning();

  await db.insert(userRoles).values([
    { userId: superAdmin.id, role: "SUPER_ADMIN", isActive: true },
    { userId: standardAdmin.id, role: "ADMIN", isActive: true },
    { userId: restrictedAdmin.id, role: "ADMIN", isActive: true },
    { userId: unapprovedAdmin.id, role: "ADMIN", isActive: true },
    { userId: suspendedAdmin.id, role: "ADMIN", isActive: false },
    { userId: parentWithAdminKeyword.id, role: "PARENT", isActive: true },
  ]);

  await db.insert(adminProfiles).values([
    {
      userId: superAdmin.id,
      department: "Executive Security",
      title: "Chief Platform Administrator",
      isApproved: true,
      permissions: [
        "dashboard:read",
        "users:read",
        "users:manage",
        "providers:read",
        "providers:verify",
        "centers:manage",
        "bookings:read",
        "bookings:manage",
        "incidents:read",
        "incidents:manage",
        "reports:read",
        "audit:read",
        "settings:manage",
      ],
    },
    {
      userId: standardAdmin.id,
      department: "Trust & Compliance",
      title: "Compliance Admin",
      isApproved: true,
      permissions: [
        "dashboard:read",
        "users:read",
        "users:manage",
        "providers:read",
        "providers:verify",
        "centers:manage",
        "bookings:read",
        "bookings:manage",
        "incidents:read",
        "incidents:manage",
        "reports:read",
        "audit:read",
      ],
    },
    {
      userId: restrictedAdmin.id,
      department: "Audit Review",
      title: "Read-Only Dashboard Viewer",
      isApproved: true,
      permissions: ["dashboard:read"],
    },
    {
      userId: unapprovedAdmin.id,
      department: "Operations",
      title: "Pending Admin",
      isApproved: false,
      permissions: ["dashboard:read"],
    },
  ]);

  const [provider] = await db
    .insert(providers)
    .values({
      ownerUserId: parentWithAdminKeyword.id,
      organizationName: "Sunshine Sprouts 24×7 Childcare",
      registrationNumber: "LS-PRV-2026-101",
      contactEmail: "director@sunshinekids.org",
      contactPhone: "+1 (555) 410-2001",
      address: "420 Evergreen Terrace",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      verificationStatus: "PENDING",
      subscriptionTier: "ENTERPRISE_24X7",
      subscriptionActive: true,
      isPublished: false,
    })
    .returning();

  const [center] = await db
    .insert(centers)
    .values({
      providerId: provider.id,
      name: "Sunshine Sprouts Downtown Campus",
      slug: "sunshine-sprouts-downtown",
      address: "420 Evergreen Terrace",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      phone: "+1 (555) 410-2001",
      email: "downtown@sunshinekids.org",
      ageGroupsSupported: ["Infant (0-12m)", "Toddler (1-3y)"],
      operatingHours: {
        Monday: { open: "00:00", close: "23:59", is24Hours: true },
      },
      is24x7: true,
      approvedCapacity: 20,
      currentOccupancy: 5,
      hourlyRate: "22.00",
      dailyRate: "165.00",
      verificationStatus: "PENDING",
      listingStatus: "PENDING_APPROVAL",
    })
    .returning();

  const TEST_VALID_PDF_BUFFER = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
    "utf8"
  );
  const TEST_VALID_PDF_SHA256 = crypto
    .createHash("sha256")
    .update(TEST_VALID_PDF_BUFFER)
    .digest("hex");

  const [orgDoc] = await db
    .insert(verificationDocuments)
    .values({
      providerId: provider.id,
      centerId: null,
      caregiverId: null,
      documentCategory: "PROVIDER",
      documentType: "STATE_CHILDCARE_LICENSE",
      documentTitle: "State Childcare Organization License",
      storageReference: "private://sunshine/state-license.pdf",
      originalFileName: "state-license.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: TEST_VALID_PDF_BUFFER.byteLength,
      checksumSha256: TEST_VALID_PDF_SHA256,
      malwareScanStatus: "CLEAN",
      malwareScanProvider: "clamav",
      malwareScannedAt: now,
      status: "VERIFIED",
      reviewedBy: superAdmin.id,
      reviewedAt: now,
      reviewNotes: "Verified against state childcare licensing registry.",
      expiresAt: new Date(now.getTime() + 180 * 86_400_000),
      uploadedBy: parentWithAdminKeyword.id,
    })
    .returning();

  const [verification] = await db
    .insert(providerVerifications)
    .values({
      providerId: provider.id,
      status: "PENDING",
      submittedAt: now,
      reviewComments: "Initial submission",
      documentReferences: [orgDoc.id],
      checklistState: { licenseVerified: true },
    })
    .returning();

  await db.insert(platformSettings).values({
    settingKey: "security.otp_expiry_minutes",
    settingValue: 5,
    category: "SECURITY",
    description: "OTP expiration window in minutes",
  });

  return {
    superAdmin,
    standardAdmin,
    restrictedAdmin,
    unapprovedAdmin,
    suspendedAdmin,
    parentWithAdminKeyword,
    provider,
    center,
    verification,
  };
}

async function runPhase1SecurityTestSuite() {
  console.log(
    "=================================================================="
  );
  console.log(
    "Little Steps — Phase 1 & Phase 2 Security & Verification Test Suite"
  );
  console.log(
    "=================================================================="
  );

  // Use isolated 32-byte (64-hex-char) test secrets in process.env for testing
  const originalOtpSecret = process.env.ADMIN_OTP_HMAC_SECRET;
  const originalSessionSecret = process.env.ADMIN_SESSION_SECRET;
  process.env.ADMIN_OTP_HMAC_SECRET =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  process.env.ADMIN_SESSION_SECRET =
    "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f";

  const { db: memoryDb, setFailNextInsertOnTable } =
    createIsolatedMemoryDatabase();
  setDatabaseInstanceForTests(memoryDb);
  setRateLimitBackendForTests("memory-test");
  resetAllRateLimitsForTests();

  const inMemoryDocumentObjects = new Map<string, Buffer>();
  const samplePdfBytes = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
    "utf8"
  );
  const samplePdfSha256 = crypto
    .createHash("sha256")
    .update(samplePdfBytes)
    .digest("hex");

  inMemoryDocumentObjects.set("sunshine/state-license.pdf", samplePdfBytes);
  inMemoryDocumentObjects.set("bright-horizons/license.pdf", samplePdfBytes);
  inMemoryDocumentObjects.set("bright-horizons/north-fire.pdf", samplePdfBytes);
  inMemoryDocumentObjects.set("bright-horizons/meera-bg.pdf", samplePdfBytes);

  setDocumentStorageAdapterForTests({
    async putObject(key, buffer) {
      inMemoryDocumentObjects.set(key, Buffer.from(buffer));
    },
    async getObject(key) {
      const found = inMemoryDocumentObjects.get(key);
      if (!found) {
        throw new Error(`Object missing from test private storage: ${key}`);
      }
      return Buffer.from(found);
    },
    async deleteObject(key) {
      inMemoryDocumentObjects.delete(key);
    },
  });

  const interceptedEmails: Array<{ toEmail: string; otpCode: string }> = [];
  setAdminOtpMailInterceptorForTests((payload) => {
    interceptedEmails.push({
      toEmail: payload.toEmail,
      otpCode: payload.otpCode,
    });
  });

  const fixtures = await seedIsolatedTestFixtures(memoryDb);

  try {
    // ========================================================================
    // PART A: Secret Handling & Cryptographic Validation Tests (Task 1)
    // ========================================================================
    console.log(
      "A1. Testing ADMIN_OTP_HMAC_SECRET & ADMIN_SESSION_SECRET Validation..."
    );
    assert.throws(
      () => validateCryptographicSecret("", "ADMIN_OTP_HMAC_SECRET"),
      AdminCryptoSecretError,
      "Empty secret must be rejected"
    );
    assert.throws(
      () =>
        validateCryptographicSecret(
          "replace-with-32-byte-cryptographically-random-hex-secret",
          "ADMIN_OTP_HMAC_SECRET"
        ),
      AdminCryptoSecretError,
      "Placeholder secret must be rejected"
    );
    assert.throws(
      () => validateCryptographicSecret("short-secret", "ADMIN_SESSION_SECRET"),
      AdminCryptoSecretError,
      "Short secret must be rejected"
    );

    const validHexKey = validateCryptographicSecret(
      process.env.ADMIN_OTP_HMAC_SECRET,
      "ADMIN_OTP_HMAC_SECRET"
    );
    assert.equal(validHexKey.byteLength, 32);

    // Ensure OTP hash and Session hash use separate keys
    const otpDigest = hashOtp("admin@littlesteps.com", "654321");
    const sessionDigest = hashSessionToken("654321");
    assert.notEqual(otpDigest, sessionDigest);
    assert.equal(
      verifyOtpHash("admin@littlesteps.com", "654321", otpDigest),
      true
    );
    console.log("    [PASS] Secret separation and 32-byte validation verified.");

    // ========================================================================
    // PART B: Required Authentication Tests (15 Cases — Task 12)
    // ========================================================================

    // Auth Test 1: Approved administrator can request an OTP
    console.log("B1. Testing Approved Administrator Can Request an OTP...");
    const reqOtpRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "request-otp"],
      query: {},
      body: { email: "admin@littlesteps.com" },
      cookies: {},
      headers: {},
      ipAddress: "10.10.0.1",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(reqOtpRes.status, 200);
    const lastSent = interceptedEmails.at(-1);
    assert.ok(lastSent && /^\d{6}$/.test(lastSent.otpCode));
    assert.equal(
      JSON.stringify(reqOtpRes.body).includes(lastSent.otpCode),
      false,
      "OTP must never be returned in API response"
    );
    console.log("    [PASS] Approved administrator OTP generated and delivered.");

    // Auth Test 2: Unauthorized email cannot gain admin access
    console.log("B2. Testing Unauthorized Email Cannot Gain Admin Access...");
    const unauthEmailRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "request-otp"],
      query: {},
      body: { email: "stranger.admin@littlesteps.com" },
      cookies: {},
      headers: {},
      ipAddress: "10.10.0.2",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(unauthEmailRes.status, 403);
    console.log("    [PASS] Unauthorized email rejected with 403.");

    // Auth Test 3: Parent with `admin` in the email cannot access admin routes
    console.log(
      "B3. Testing Parent with 'admin' in Email (parent.admin@example.com) Rejected..."
    );
    const parentAdminRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "request-otp"],
      query: {},
      body: { email: "parent.admin@example.com" },
      cookies: {},
      headers: {},
      ipAddress: "10.10.0.3",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(parentAdminRes.status, 403);
    console.log("    [PASS] Parent with 'admin' in email rejected with 403.");

    // Auth Test 4: Suspended administrator cannot authenticate
    console.log("B4. Testing Suspended Administrator Cannot Authenticate...");
    const suspendedRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "request-otp"],
      query: {},
      body: { email: "suspended.admin@littlesteps.com" },
      cookies: {},
      headers: {},
      ipAddress: "10.10.0.4",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(suspendedRes.status, 403);
    console.log("    [PASS] Suspended administrator rejected with 403.");

    // Auth Test 5: Unapproved administrator cannot authenticate
    console.log("B5. Testing Unapproved Administrator Cannot Authenticate...");
    const unapprovedRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "request-otp"],
      query: {},
      body: { email: "unapproved.admin@littlesteps.com" },
      cookies: {},
      headers: {},
      ipAddress: "10.10.0.5",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(unapprovedRes.status, 403);
    // Verify uniform error code across B2, B3, B4, B5 (no account enumeration)
    assert.deepEqual(unauthEmailRes.body, parentAdminRes.body);
    assert.deepEqual(parentAdminRes.body, suspendedRes.body);
    assert.deepEqual(suspendedRes.body, unapprovedRes.body);
    console.log(
      "    [PASS] Unapproved administrator rejected with uniform anti-enumeration 403."
    );

    // Auth Test 11: OTP resend cooldown & invalidation of previous OTPs
    console.log(
      "B6. Testing OTP Resend Cooldown & Previous OTP Invalidation..."
    );
    const firstOtp = lastSent.otpCode;
    const immediateResend = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "resend-otp"],
      query: {},
      body: { email: "admin@littlesteps.com" },
      cookies: {},
      headers: {},
      ipAddress: "10.10.0.6",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(immediateResend.status, 429);

    // Fast-forward resendAvailableAt to test replacement invalidation
    await memoryDb
      .update(adminOtpChallenges)
      .set({ resendAvailableAt: new Date(Date.now() - 1000) })
      .where(undefined);

    const validResend = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "resend-otp"],
      query: {},
      body: { email: "admin@littlesteps.com" },
      cookies: {},
      headers: {},
      ipAddress: "10.10.0.6",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(validResend.status, 200);
    const secondOtp = interceptedEmails.at(-1)!.otpCode;

    // Attempting to verify using the older (replaced) OTP must fail
    if (firstOtp !== secondOtp) {
      const oldOtpVerify = await dispatchAdminApiRequest({
        method: "POST",
        segments: ["auth", "verify-otp"],
        query: {},
        body: { email: "admin@littlesteps.com", otp: firstOtp },
        cookies: {},
        headers: {},
        ipAddress: "10.10.0.6",
        userAgent: "Phase1SecurityTest/1.0",
      });
      assert.equal(oldOtpVerify.status, 401);
    }
    console.log(
      "    [PASS] 60s resend cooldown and prior challenge invalidation verified."
    );

    // Auth Test 7: Incorrect OTP is rejected (up to 5 attempts lockout)
    console.log("B7. Testing Incorrect OTP Rejection & Max Attempts Lockout...");
    await memoryDb
      .update(adminOtpChallenges)
      .set({ resendAvailableAt: new Date(Date.now() - 1000) })
      .where(undefined);
    resetAllRateLimitsForTests();

    await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "request-otp"],
      query: {},
      body: { email: "admin@littlesteps.com" },
      cookies: {},
      headers: {},
      ipAddress: "10.10.0.7",
      userAgent: "Phase1SecurityTest/1.0",
    });
    const activeOtpForLockout = interceptedEmails.at(-1)!.otpCode;
    const wrongOtp = activeOtpForLockout === "000000" ? "999999" : "000000";

    for (let attempt = 1; attempt <= 4; attempt++) {
      const badRes = await dispatchAdminApiRequest({
        method: "POST",
        segments: ["auth", "verify-otp"],
        query: {},
        body: { email: "admin@littlesteps.com", otp: wrongOtp },
        cookies: {},
        headers: {},
        ipAddress: `10.10.1.${attempt}`,
        userAgent: "Phase1SecurityTest/1.0",
      });
      assert.equal(badRes.status, 401);
    }

    const fifthRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "verify-otp"],
      query: {},
      body: { email: "admin@littlesteps.com", otp: wrongOtp },
      cookies: {},
      headers: {},
      ipAddress: "10.10.1.5",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(fifthRes.status, 429);
    console.log("    [PASS] Incorrect OTP rejected and locked out on 5th attempt.");

    // Auth Test 8: Expired OTP is rejected
    console.log("B8. Testing Expired OTP is Rejected...");
    await memoryDb
      .update(adminOtpChallenges)
      .set({ resendAvailableAt: new Date(Date.now() - 1000) })
      .where(undefined);
    resetAllRateLimitsForTests();

    await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "request-otp"],
      query: {},
      body: { email: "admin@littlesteps.com" },
      cookies: {},
      headers: {},
      ipAddress: "10.10.0.8",
      userAgent: "Phase1SecurityTest/1.0",
    });
    const expiringOtp = interceptedEmails.at(-1)!.otpCode;

    await memoryDb
      .update(adminOtpChallenges)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(undefined);

    const expiredRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "verify-otp"],
      query: {},
      body: { email: "admin@littlesteps.com", otp: expiringOtp },
      cookies: {},
      headers: {},
      ipAddress: "10.10.0.8",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(expiredRes.status, 400);
    console.log("    [PASS] Expired OTP rejected with 400.");

    // Auth Test 6, 9, 10: Correct OTP creates a valid session, Concurrent OTP verification
    // cannot create multiple sessions, and Previously consumed OTP cannot be reused
    console.log(
      "B9. Testing Atomic OTP Verification, Concurrent Race Prevention & Replay Protection..."
    );
    await memoryDb
      .update(adminOtpChallenges)
      .set({ resendAvailableAt: new Date(Date.now() - 1000) })
      .where(undefined);
    resetAllRateLimitsForTests();

    await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "request-otp"],
      query: {},
      body: { email: "superadmin@littlesteps.com" },
      cookies: {},
      headers: {},
      ipAddress: "10.10.0.9",
      userAgent: "Phase1SecurityTest/1.0",
    });
    const superAdminOtp = interceptedEmails.at(-1)!.otpCode;

    // Fire two simultaneous verification requests with the exact same valid OTP
    const [raceRes1, raceRes2] = await Promise.all([
      dispatchAdminApiRequest({
        method: "POST",
        segments: ["auth", "verify-otp"],
        query: {},
        body: { email: "superadmin@littlesteps.com", otp: superAdminOtp },
        cookies: {},
        headers: {},
        ipAddress: "10.10.0.9",
        userAgent: "Phase1SecurityTest/1.0",
      }),
      dispatchAdminApiRequest({
        method: "POST",
        segments: ["auth", "verify-otp"],
        query: {},
        body: { email: "superadmin@littlesteps.com", otp: superAdminOtp },
        cookies: {},
        headers: {},
        ipAddress: "10.10.0.10",
        userAgent: "Phase1SecurityTest/1.0",
      }),
    ]);

    const statuses = [raceRes1.status, raceRes2.status].sort();
    assert.deepEqual(
      statuses,
      [200, 400],
      "Exactly one concurrent OTP verification may succeed (200) while the other is rejected (400)"
    );

    const winningRes = raceRes1.status === 200 ? raceRes1 : raceRes2;

    // Sequential replay attempt with the already consumed OTP must also fail with 400
    const replayRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "verify-otp"],
      query: {},
      body: { email: "superadmin@littlesteps.com", otp: superAdminOtp },
      cookies: {},
      headers: {},
      ipAddress: "10.10.0.9",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(replayRes.status, 400);
    console.log(
      "    [PASS] Correct OTP session creation, concurrent race block, and replay prevention verified."
    );

    // Auth Test 12: Rate limiting works correctly under burst
    console.log("B10. Testing Rate Limiting Enforcement...");
    resetAllRateLimitsForTests();
    const rateResponses = await Promise.all(
      Array.from({ length: 7 }, () =>
        dispatchAdminApiRequest({
          method: "POST",
          segments: ["auth", "request-otp"],
          query: {},
          body: { email: "admin@littlesteps.com" },
          cookies: {},
          headers: {},
          ipAddress: "10.99.99.99",
          userAgent: "Phase1SecurityTest/1.0",
        })
      )
    );
    const has429 = rateResponses.some((r) => r.status === 429);
    assert.equal(has429, true, "Burst exceeding account limit of 5 must return 429");
    resetAllRateLimitsForTests();
    console.log("    [PASS] Concurrency-safe rate limiting verified.");

    // Extract Super Admin cookies & CSRF token
    const superSessionCookie = winningRes.cookiesToSet?.find(
      (c: CookieInstruction) => c.name === ADMIN_SESSION_COOKIE_NAME
    );
    const superCsrfCookie = winningRes.cookiesToSet?.find(
      (c: CookieInstruction) => c.name === ADMIN_CSRF_COOKIE_NAME
    );
    assert.ok(superSessionCookie?.value);
    assert.equal(superSessionCookie?.httpOnly, true);
    assert.ok(superCsrfCookie?.value);

    const superCookies = {
      [ADMIN_SESSION_COOKIE_NAME]: superSessionCookie.value,
      [ADMIN_CSRF_COOKIE_NAME]: superCsrfCookie.value,
    };
    const superHeaders = {
      [ADMIN_CSRF_HEADER_NAME]: superCsrfCookie.value,
    };

    // Auth Test 15: Missing or invalid CSRF token is rejected
    console.log("B11. Testing Missing or Invalid CSRF Token & Origin Mismatch Rejection...");
    const noCsrfMutation = await dispatchAdminApiRequest({
      method: "PATCH",
      segments: ["settings"],
      query: {},
      body: {
        settings: [
          { settingKey: "security.otp_expiry_minutes", settingValue: 5 },
        ],
      },
      cookies: superCookies,
      headers: {},
      ipAddress: "10.10.0.11",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(noCsrfMutation.status, 403);

    const badOriginMutation = await dispatchAdminApiRequest({
      method: "PATCH",
      segments: ["settings"],
      query: {},
      body: {
        settings: [
          { settingKey: "security.otp_expiry_minutes", settingValue: 5 },
        ],
      },
      cookies: superCookies,
      headers: {
        ...superHeaders,
        origin: "https://evil-attacker.example.com",
        host: "localhost:3000",
      },
      ipAddress: "10.10.0.11",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(badOriginMutation.status, 403);
    console.log("    [PASS] CSRF token and Origin validation verified.");

    // ========================================================================
    // PART C: Required Authorization Tests (7 Cases — Task 4 & Task 12)
    // ========================================================================
    console.log(
      "C1. Testing Unauthenticated Requests Receive HTTP 401..."
    );
    const unauthDashboard = await dispatchAdminApiRequest({
      method: "GET",
      segments: ["dashboard", "stats"],
      query: {},
      body: {},
      cookies: {},
      headers: {},
      ipAddress: "10.20.0.1",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(unauthDashboard.status, 401);
    console.log("    [PASS] Unauthenticated requests receive HTTP 401.");

    // Authenticate as Restricted Read-Only Admin (`readonly.admin@littlesteps.com` with only `["dashboard:read"]`)
    console.log(
      "C2. Testing Granular Least-Privilege Authorization (HTTP 403 on Unauthorized Read & Mutation)..."
    );
    await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "request-otp"],
      query: {},
      body: { email: "readonly.admin@littlesteps.com" },
      cookies: {},
      headers: {},
      ipAddress: "10.20.0.2",
      userAgent: "Phase1SecurityTest/1.0",
    });
    const restrictedOtp = interceptedEmails.at(-1)!.otpCode;
    const restrictedLogin = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "verify-otp"],
      query: {},
      body: { email: "readonly.admin@littlesteps.com", otp: restrictedOtp },
      cookies: {},
      headers: {},
      ipAddress: "10.20.0.2",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(restrictedLogin.status, 200);

    const restrictedSession = restrictedLogin.cookiesToSet!.find(
      (c) => c.name === ADMIN_SESSION_COOKIE_NAME
    )!;
    const restrictedCsrf = restrictedLogin.cookiesToSet!.find(
      (c) => c.name === ADMIN_CSRF_COOKIE_NAME
    )!;
    const restrictedCookies = {
      [ADMIN_SESSION_COOKIE_NAME]: restrictedSession.value,
      [ADMIN_CSRF_COOKIE_NAME]: restrictedCsrf.value,
    };
    const restrictedHeaders = {
      [ADMIN_CSRF_HEADER_NAME]: restrictedCsrf.value,
    };

    // Allowed: `dashboard:read`
    const allowedDashboard = await dispatchAdminApiRequest({
      method: "GET",
      segments: ["dashboard", "stats"],
      query: {},
      body: {},
      cookies: restrictedCookies,
      headers: {},
      ipAddress: "10.20.0.2",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(allowedDashboard.status, 200);

    // Denied: `users:read` (sensitive user records)
    const deniedUsersRead = await dispatchAdminApiRequest({
      method: "GET",
      segments: ["users"],
      query: {},
      body: {},
      cookies: restrictedCookies,
      headers: {},
      ipAddress: "10.20.0.2",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(deniedUsersRead.status, 403);

    // Denied: `incidents:read` (sensitive incident records)
    const deniedIncidentsRead = await dispatchAdminApiRequest({
      method: "GET",
      segments: ["incidents"],
      query: {},
      body: {},
      cookies: restrictedCookies,
      headers: {},
      ipAddress: "10.20.0.2",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(deniedIncidentsRead.status, 403);

    // Denied: `settings:manage` (updating platform settings)
    const deniedSettingsUpdate = await dispatchAdminApiRequest({
      method: "PATCH",
      segments: ["settings"],
      query: {},
      body: {
        settings: [
          { settingKey: "security.otp_expiry_minutes", settingValue: 10 },
        ],
      },
      cookies: restrictedCookies,
      headers: restrictedHeaders,
      ipAddress: "10.20.0.2",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(deniedSettingsUpdate.status, 403);

    // Denied: `providers:verify` (provider verification restricted to authorized administrators)
    const deniedProviderVerify = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verifications", fixtures.verification.id, "approve"],
      query: {},
      body: {
        reviewComments: "Unauthorized approval attempt",
      },
      cookies: restrictedCookies,
      headers: restrictedHeaders,
      ipAddress: "10.20.0.2",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(deniedProviderVerify.status, 403);

    // Authorized Super Admin with `providers:verify` succeeds
    const authorizedProviderVerify = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verifications", fixtures.verification.id, "approve"],
      query: {},
      body: {
        reviewComments: "All childcare permits and safety checks verified.",
        checklistState: {
          licenseVerified: true,
          organizationDetailsVerified: true,
        },
      },
      cookies: superCookies,
      headers: superHeaders,
      ipAddress: "10.20.0.3",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(authorizedProviderVerify.status, 200);

    // Verify SUPER_ADMIN follows explicit privilege rules (unknown arbitrary permissions rejected)
    const resolvedSuperPerms = resolveEffectiveAdminPermissions("SUPER_ADMIN", [
      "dashboard:read",
      "arbitrary:nonexistent_privilege",
    ]);
    assert.deepEqual(resolvedSuperPerms, ["dashboard:read"]);
    assert.equal(
      hasAdminPermission(
        { role: "SUPER_ADMIN", permissions: ["dashboard:read"] },
        "settings:manage"
      ),
      false
    );
    console.log(
      "    [PASS] All 7 granular authorization & SUPER_ADMIN privilege rules verified."
    );

    // ========================================================================
    // PART D: Session Expiration & Logout Invalidation (Auth Tests 13 & 14)
    // ========================================================================
    console.log("D1. Testing Expired Sessions Are Denied & Logout Revokes Session...");
    // Expire the restricted admin session
    const [restrictedSessionRow] = await memoryDb
      .select()
      .from(adminSessions)
      .where(
        undefined
      );
    assert.ok(restrictedSessionRow);

    // Logout superAdmin session
    const logoutRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "logout"],
      query: {},
      body: {},
      cookies: superCookies,
      headers: superHeaders,
      ipAddress: "10.20.0.3",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(logoutRes.status, 200);

    const afterLogoutRes = await dispatchAdminApiRequest({
      method: "GET",
      segments: ["dashboard", "stats"],
      query: {},
      body: {},
      cookies: superCookies,
      headers: {},
      ipAddress: "10.20.0.3",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(afterLogoutRes.status, 401);

    // Expire restrictedAdmin's session in DB and verify 401
    await memoryDb
      .update(adminSessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(undefined);

    const expiredSessionRes = await dispatchAdminApiRequest({
      method: "GET",
      segments: ["dashboard", "stats"],
      query: {},
      body: {},
      cookies: restrictedCookies,
      headers: {},
      ipAddress: "10.20.0.2",
      userAgent: "Phase1SecurityTest/1.0",
    });
    assert.equal(expiredSessionRes.status, 401);
    console.log(
      "    [PASS] Session expiration and logout revocation verified."
    );

    // ========================================================================
    // PART E: Audit Log Integrity & Non-Sensitive Data Verification (Task 10)
    // ========================================================================
    console.log("E1. Testing Audit Log Integrity & Sensitive Data Redaction...");
    const allLogs = await memoryDb.select().from(adminAuditLogs);
    assert.ok(allLogs.length >= 8);
    const latestLog = allLogs.at(-1)!;
    const verification = verifyAuditIntegrityHash(
      {
        adminEmail: latestLog.adminEmail,
        action: latestLog.action,
        entityType: latestLog.entityType,
        entityId: latestLog.entityId,
        summary: latestLog.summary,
        timestampIso: latestLog.createdAt.toISOString(),
      },
      latestLog.integrityHash
    );
    assert.equal(verification.valid, true);
    assert.equal(verification.keyGeneration, "current");

    // Ensure no OTP code ever appeared in any audit log record
    const serializedAuditLogs = JSON.stringify(allLogs);
    for (const emailItem of interceptedEmails) {
      assert.equal(
        serializedAuditLogs.includes(emailItem.otpCode),
        false,
        "Plaintext OTP must never appear in audit logs"
      );
    }
    console.log(
      "    [PASS] Audit log HMAC integrity and sensitive-value redaction verified."
    );

    // ========================================================================
    // PART F: Phase 2 — Database Integrity & Secure Provider Verification
    // ========================================================================
    console.log(
      "F1. Testing Phase 2 Safe Schema Defaults & CHECK Constraints..."
    );

    // 1. Caregivers default to NOT_VERIFIED
    assert.equal(
      caregivers.backgroundCheckStatus.default,
      "NOT_VERIFIED",
      "caregivers.backgroundCheckStatus must default to NOT_VERIFIED"
    );

    // 2. Bookings paymentStatus defaults to PENDING
    assert.equal(
      bookings.paymentStatus.default,
      "PENDING",
      "bookings.paymentStatus must default to PENDING"
    );

    // 3. Daycare centres listingStatus defaults to PENDING_APPROVAL
    assert.equal(
      centers.listingStatus.default,
      "PENDING_APPROVAL",
      "centers.listingStatus must default to PENDING_APPROVAL"
    );

    // 4. Daycare centres do not receive a fabricated default rating
    assert.equal(
      centers.rating.hasDefault,
      false,
      "centers.rating must not have a fabricated default rating"
    );

    // 5. Admin profiles default to isApproved = false
    assert.equal(
      adminProfiles.isApproved.default,
      false,
      "adminProfiles.isApproved must default to false"
    );

    // 6. Verify PostgreSQL CHECK constraints exist on schema tables
    const centerCheckNames = getTableConfig(centers).checks.map((c) => c.name);
    assert.ok(centerCheckNames.includes("centers_approved_capacity_nonneg"));
    assert.ok(centerCheckNames.includes("centers_current_occupancy_nonneg"));
    assert.ok(centerCheckNames.includes("centers_hourly_rate_nonneg"));
    assert.ok(centerCheckNames.includes("centers_daily_rate_nonneg"));
    assert.ok(centerCheckNames.includes("centers_rating_range_chk"));

    const bookingCheckNames = getTableConfig(bookings).checks.map((c) => c.name);
    assert.ok(bookingCheckNames.includes("bookings_valid_time_range"));
    assert.ok(bookingCheckNames.includes("bookings_total_amount_nonneg"));
    assert.ok(bookingCheckNames.includes("bookings_payment_status_valid"));

    const caregiverCheckNames = getTableConfig(caregivers).checks.map(
      (c) => c.name
    );
    assert.ok(caregiverCheckNames.includes("caregivers_years_exp_nonneg"));
    assert.ok(caregiverCheckNames.includes("caregivers_bg_status_valid"));

    const docCheckNames = getTableConfig(verificationDocuments).checks.map(
      (c) => c.name
    );
    assert.ok(docCheckNames.includes("verification_documents_size_nonneg"));
    assert.ok(docCheckNames.includes("verification_documents_status_valid"));

    console.log(
      "    [PASS] All 6 Phase 2 schema defaults and CHECK constraints verified."
    );

    // Authenticate standardAdmin (Priya Sharma) for Phase 2 workflow tests
    resetAllRateLimitsForTests();
    await memoryDb
      .update(adminOtpChallenges)
      .set({ invalidatedAt: new Date() })
      .where(undefined);
    const p2ReqOtp = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "request-otp"],
      query: {},
      body: { email: "admin@littlesteps.com" },
      cookies: {},
      headers: {},
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(p2ReqOtp.status, 200);
    const p2OtpCode = interceptedEmails.at(-1)!.otpCode;
    const p2VerifyRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "verify-otp"],
      query: {},
      body: { email: "admin@littlesteps.com", otp: p2OtpCode },
      cookies: {},
      headers: {},
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(p2VerifyRes.status, 200);
    const p2Cookies = Object.fromEntries(
      (p2VerifyRes.cookiesToSet ?? []).map((c: CookieInstruction) => [
        c.name,
        c.value,
      ])
    );
    const p2Headers = {
      [ADMIN_CSRF_HEADER_NAME]: p2Cookies[ADMIN_CSRF_COOKIE_NAME],
      host: "localhost:3000",
      origin: "http://localhost:3000",
    };

    console.log(
      "F2. Testing Independent Provider Verification (No Bulk Approval & Strict Preconditions)..."
    );

    // Create a second provider with 2 centres, 1 caregiver, and 1 SUBMITTED (unverified) document
    const [p2Owner] = await memoryDb
      .insert(users)
      .values({
        email: "owner2@littlesteps.com",
        name: "Rohan Verma",
        role: "PROVIDER",
        status: "ACTIVE",
        emailVerified: true,
      })
      .returning();

    const [p2Provider] = await memoryDb
      .insert(providers)
      .values({
        ownerUserId: p2Owner.id,
        organizationName: "Bright Horizons 24×7 Care",
        registrationNumber: "LS-PRV-2026-202",
        contactEmail: "compliance@brighthorizons.example",
        contactPhone: "+1 (555) 820-9000",
        address: "900 Congress Ave",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        verificationStatus: "PENDING",
        subscriptionTier: "ENTERPRISE_24X7",
        subscriptionActive: true,
        isPublished: false,
      })
      .returning();

    const [p2CenterA, p2CenterB] = await memoryDb
      .insert(centers)
      .values([
        {
          providerId: p2Provider.id,
          name: "Bright Horizons North Campus",
          slug: "bright-horizons-north",
          address: "901 North Lamar",
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          phone: "+1 (555) 820-9001",
          email: "north@brighthorizons.example",
          ageGroupsSupported: ["Infant (0-12m)", "Toddler (1-3y)"],
          operatingHours: {
            Monday: { open: "00:00", close: "23:59", is24Hours: true },
          },
          is24x7: true,
          approvedCapacity: 18,
          currentOccupancy: 2,
          hourlyRate: "24.00",
          dailyRate: "175.00",
          verificationStatus: "PENDING",
          listingStatus: "PENDING_APPROVAL",
          rating: null,
        },
        {
          providerId: p2Provider.id,
          name: "Bright Horizons South Campus",
          slug: "bright-horizons-south",
          address: "500 South Congress",
          city: "Austin",
          state: "TX",
          postalCode: "78704",
          phone: "+1 (555) 820-9002",
          email: "south@brighthorizons.example",
          ageGroupsSupported: ["Toddler (1-3y)", "Preschool (3-5y)"],
          operatingHours: {
            Monday: { open: "07:00", close: "19:00", is24Hours: false },
          },
          is24x7: false,
          approvedCapacity: 15,
          currentOccupancy: 0,
          hourlyRate: "20.00",
          dailyRate: "150.00",
          verificationStatus: "PENDING",
          listingStatus: "PENDING_APPROVAL",
          rating: null,
        },
      ])
      .returning();

    const [p2Caregiver] = await memoryDb
      .insert(caregivers)
      .values({
        centerId: p2CenterA.id,
        fullName: "Meera Nair",
        email: "meera.nair@brighthorizons.example",
        phone: "+1 (555) 820-9111",
        roleTitle: "Lead Infant Caregiver",
        certifications: ["Pediatric CPR", "Early Childhood Education"],
        backgroundCheckStatus: "NOT_VERIFIED",
        yearsExperience: 6,
        isActive: true,
      })
      .returning();

    const [p2Verif] = await memoryDb
      .insert(providerVerifications)
      .values({
        providerId: p2Provider.id,
        status: "PENDING",
        submittedAt: new Date(),
        documentReferences: [],
        checklistState: {},
      })
      .returning();

    // Test 5: Provider approval fails when required organization documents are missing
    const failNoDocs = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verifications", p2Verif.id, "approve"],
      query: {},
      body: {
        reviewComments: "Attempting approval without documents",
        checklistState: {
          licenseVerified: true,
          organizationDetailsVerified: true,
        },
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(failNoDocs.status, 400);

    // Upload an unverified (SUBMITTED) organization document
    const [p2OrgDoc] = await memoryDb
      .insert(verificationDocuments)
      .values({
        providerId: p2Provider.id,
        centerId: null,
        caregiverId: null,
        documentCategory: "PROVIDER",
        documentType: "STATE_CHILDCARE_LICENSE",
        documentTitle: "Bright Horizons State Childcare License",
        storageReference: "private://bright-horizons/license.pdf",
        originalFileName: "license.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: samplePdfBytes.byteLength,
        checksumSha256: samplePdfSha256,
        malwareScanStatus: "CLEAN",
        malwareScanProvider: "clamav",
        malwareScannedAt: new Date(),
        status: "SUBMITTED",
        expiresAt: new Date(Date.now() + 365 * 86_400_000),
        uploadedBy: p2Owner.id,
      })
      .returning();

    // Also upload a centre document (SUBMITTED) to verify provider approval does not auto-verify it
    const [p2CenterADoc] = await memoryDb
      .insert(verificationDocuments)
      .values({
        providerId: p2Provider.id,
        centerId: p2CenterA.id,
        caregiverId: null,
        documentCategory: "CENTER",
        documentType: "FIRE_SAFETY_PERMIT",
        documentTitle: "North Campus Municipal Fire Permit",
        storageReference: "private://bright-horizons/north-fire.pdf",
        originalFileName: "north-fire.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: samplePdfBytes.byteLength,
        checksumSha256: samplePdfSha256,
        malwareScanStatus: "CLEAN",
        malwareScanProvider: "clamav",
        malwareScannedAt: new Date(),
        status: "SUBMITTED",
        expiresAt: new Date(Date.now() + 365 * 86_400_000),
        uploadedBy: p2Owner.id,
      })
      .returning();

    // Test 6a: Provider approval fails when required organization document is still SUBMITTED (unverified)
    const failUnverifiedDoc = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verifications", p2Verif.id, "approve"],
      query: {},
      body: {
        reviewComments: "Attempting approval while org doc is still SUBMITTED",
        checklistState: {
          licenseVerified: true,
          organizationDetailsVerified: true,
        },
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(failUnverifiedDoc.status, 400);

    // Test 9: Requesting documents transitions provider verification to UNDER_REVIEW
    const reqDocsRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verifications", p2Verif.id, "request-documents"],
      query: {},
      body: {
        requestedDocuments: ["STATE_CHILDCARE_LICENSE"],
        reviewComments: "Please verify state childcare license authenticity.",
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(reqDocsRes.status, 200);
    const [p2VerifAfterReq] = await memoryDb
      .select()
      .from(providerVerifications)
      .where(undefined);
    assert.ok(p2VerifAfterReq);

    // Individually approve the organization document via POST /verification-documents/:id/approve
    const approveOrgDocRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", p2OrgDoc.id, "approve"],
      query: {},
      body: {
        reviewNotes: "Verified state license number against state registry.",
        evidenceReviewed: true,
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(approveOrgDocRes.status, 200);

    // Test 7: Provider approval fails when checklistState.licenseVerified is false or missing
    const failChecklistFalse = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verifications", p2Verif.id, "approve"],
      query: {},
      body: {
        reviewComments: "Checklist incomplete test",
        checklistState: {
          licenseVerified: false,
          organizationDetailsVerified: true,
        },
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(failChecklistFalse.status, 400);

    // Test 10: Self-approval is rejected (403 SELF_APPROVAL_FORBIDDEN) when provider owner is the reviewer
    await memoryDb
      .update(providers)
      .set({ ownerUserId: fixtures.standardAdmin.id })
      .where(undefined);
    const failSelfApprove = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verifications", p2Verif.id, "approve"],
      query: {},
      body: {
        reviewComments: "Attempting self-approval",
        checklistState: {
          licenseVerified: true,
          organizationDetailsVerified: true,
        },
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(failSelfApprove.status, 403);
    // Restore ownerUserId
    await memoryDb
      .update(providers)
      .set({ ownerUserId: p2Owner.id })
      .where(undefined);

    // Test 1, 2, 3, 4: Approve Provider Verification and verify NO bulk approval of centres, caregivers, or unverified centre docs
    const approveProvRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verifications", p2Verif.id, "approve"],
      query: {},
      body: {
        reviewComments: "Organization license and registration independently verified.",
        checklistState: {
          licenseVerified: true,
          organizationDetailsVerified: true,
        },
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(approveProvRes.status, 200);

    const allCentersAfterProvApproval = await memoryDb.select().from(centers);
    const centerAAfter = allCentersAfterProvApproval.find(
      (c) => c.id === p2CenterA.id
    )!;
    const centerBAfter = allCentersAfterProvApproval.find(
      (c) => c.id === p2CenterB.id
    )!;
    assert.equal(
      centerAAfter.verificationStatus,
      "PENDING",
      "Provider approval must NOT bulk-approve daycare centres"
    );
    assert.equal(
      centerAAfter.listingStatus,
      "PENDING_APPROVAL",
      "Provider approval must NOT bulk-activate daycare centre listings"
    );
    assert.equal(centerBAfter.verificationStatus, "PENDING");
    assert.equal(centerBAfter.listingStatus, "PENDING_APPROVAL");

    const allCaregiversAfterProvApproval = await memoryDb
      .select()
      .from(caregivers);
    const cgAfter = allCaregiversAfterProvApproval.find(
      (cg) => cg.id === p2Caregiver.id
    )!;
    assert.equal(
      cgAfter.backgroundCheckStatus,
      "NOT_VERIFIED",
      "Provider approval must NOT bulk-verify caregivers"
    );

    const allDocsAfterProvApproval = await memoryDb
      .select()
      .from(verificationDocuments);
    const centerDocAfter = allDocsAfterProvApproval.find(
      (d) => d.id === p2CenterADoc.id
    )!;
    assert.equal(
      centerDocAfter.status,
      "SUBMITTED",
      "Provider approval must NOT bulk-verify unreviewed documents"
    );

    console.log(
      "    [PASS] Independent provider verification (no bulk side-effects, self-approval block, document & checklist gates) verified."
    );

    console.log(
      "F3. Testing Caregiver Verification, Document Security & Centre Verification Gates..."
    );

    // Private storage path protection: GET /verification-documents must never leak storageReference
    const listDocsRes = await dispatchAdminApiRequest({
      method: "GET",
      segments: ["verification-documents"],
      query: {},
      body: {},
      cookies: p2Cookies,
      headers: {},
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(listDocsRes.status, 200);
    const serializedDocs = JSON.stringify(listDocsRes.body);
    assert.equal(
      serializedDocs.includes("s3://private-vault") ||
        serializedDocs.includes("private://bright-horizons"),
      false,
      "Raw private storageReference must never be exposed in API responses"
    );

    // Centre Verification Gate 1: Cannot approve p2CenterA while p2CenterADoc is still SUBMITTED and caregiver is NOT_VERIFIED
    const failCenterBeforeCgAndDoc = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["center-verifications", p2CenterA.id, "approve"],
      query: {},
      body: {
        reviewComments: "Attempting premature centre approval",
        checklistState: {
          operatingLicenseVerified: true,
          facilitySafetyVerified: true,
          caregiverQualificationVerified: true,
          capacityVerified: true,
          operatingHoursVerified: true,
          ageGroupsVerified: true,
        },
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(failCenterBeforeCgAndDoc.status, 400);

    // Approve p2CenterADoc first
    const approveCenterDocRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", p2CenterADoc.id, "approve"],
      query: {},
      body: {
        reviewNotes: "Verified municipal fire permit for North Campus.",
        evidenceReviewed: true,
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(approveCenterDocRes.status, 200);

    // Centre Verification Gate 2: Still cannot approve p2CenterA because caregiver is NOT_VERIFIED
    const failCenterNoVerifiedCaregiver = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["center-verifications", p2CenterA.id, "approve"],
      query: {},
      body: {
        reviewComments: "Attempting centre approval without verified caregiver",
        checklistState: {
          operatingLicenseVerified: true,
          facilitySafetyVerified: true,
          caregiverQualificationVerified: true,
          capacityVerified: true,
          operatingHoursVerified: true,
          ageGroupsVerified: true,
        },
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(failCenterNoVerifiedCaregiver.status, 400);

    // Caregiver Verification Test 2: Caregiver approval fails without a verified supporting screening document
    const failCgNoDoc = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["caregiver-verifications", p2Caregiver.id, "approve"],
      query: {},
      body: {
        reviewComments: "Attempting caregiver verification without screening document",
        checklistState: {
          backgroundScreeningVerified: true,
          credentialsVerified: true,
        },
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(failCgNoDoc.status, 400);

    // Upload & verify caregiver screening document
    const [p2CgDoc] = await memoryDb
      .insert(verificationDocuments)
      .values({
        providerId: p2Provider.id,
        centerId: p2CenterA.id,
        caregiverId: p2Caregiver.id,
        documentCategory: "CAREGIVER",
        documentType: "BACKGROUND_CHECK_CLEARANCE",
        documentTitle: "Meera Nair National Criminal & Childcare Background Clearance",
        storageReference: "private://bright-horizons/meera-bg.pdf",
        originalFileName: "meera-bg.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: samplePdfBytes.byteLength,
        checksumSha256: samplePdfSha256,
        malwareScanStatus: "CLEAN",
        malwareScanProvider: "clamav",
        malwareScannedAt: new Date(),
        status: "VERIFIED",
        reviewedBy: fixtures.standardAdmin.id,
        reviewedAt: new Date(),
        reviewNotes: "Verified clean background check and CPR certification.",
        expiresAt: new Date(Date.now() + 365 * 86_400_000),
        uploadedBy: p2Owner.id,
      })
      .returning();
    assert.ok(p2CgDoc);

    // Approve Caregiver Verification
    const approveCgRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["caregiver-verifications", p2Caregiver.id, "approve"],
      query: {},
      body: {
        reviewComments: "Verified criminal background check and pediatric CPR credentials.",
        checklistState: {
          backgroundScreeningVerified: true,
          credentialsVerified: true,
        },
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(approveCgRes.status, 200);

    // Caregiver Verification Test 4: Expired caregiver verification does not satisfy centre staffing requirements
    await memoryDb
      .update(caregivers)
      .set({ verificationExpiresAt: new Date(Date.now() - 60_000) })
      .where(undefined);

    const failCenterWithExpiredCg = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["center-verifications", p2CenterA.id, "approve"],
      query: {},
      body: {
        reviewComments: "Attempting centre approval with expired caregiver",
        checklistState: {
          operatingLicenseVerified: true,
          facilitySafetyVerified: true,
          caregiverQualificationVerified: true,
          capacityVerified: true,
          operatingHoursVerified: true,
          ageGroupsVerified: true,
        },
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(failCenterWithExpiredCg.status, 400);

    // Restore valid future caregiver expiration date
    await memoryDb
      .update(caregivers)
      .set({
        verificationExpiresAt: new Date(Date.now() + 365 * 86_400_000),
      })
      .where(undefined);

    // Now approve p2CenterA with all requirements met
    const approveCenterARes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["center-verifications", p2CenterA.id, "approve"],
      query: {},
      body: {
        reviewComments:
          "Verified North Campus fire permit, capacity rules, and qualified caregiver staffing.",
        checklistState: {
          operatingLicenseVerified: true,
          facilitySafetyVerified: true,
          caregiverQualificationVerified: true,
          capacityVerified: true,
          operatingHoursVerified: true,
          ageGroupsVerified: true,
        },
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(approveCenterARes.status, 200);

    // Centre Verification Test 6: Approving p2CenterA does NOT approve p2CenterB of the same provider
    const centersAfterCenterAApproval = await memoryDb.select().from(centers);
    const updatedCenterA = centersAfterCenterAApproval.find(
      (c) => c.id === p2CenterA.id
    )!;
    const untouchedCenterB = centersAfterCenterAApproval.find(
      (c) => c.id === p2CenterB.id
    )!;
    assert.equal(updatedCenterA.verificationStatus, "APPROVED");
    assert.equal(updatedCenterA.listingStatus, "ACTIVE");
    assert.equal(
      untouchedCenterB.verificationStatus,
      "PENDING",
      "Approving one centre must never approve another centre of the same provider"
    );
    assert.equal(untouchedCenterB.listingStatus, "PENDING_APPROVAL");

    // Centre Verification Test 5: Unverified/pending-approval centre (p2CenterB) cannot confirm bookings
    const [testChild] = await memoryDb
      .insert(children)
      .values({
        parentId: fixtures.parentWithAdminKeyword.id,
        firstName: "Aanya",
        ageMonths: 18,
        ageGroup: "Toddler (1-3y)",
      })
      .returning();

    const [unverifiedCenterBooking] = await memoryDb
      .insert(bookings)
      .values({
        bookingReference: "LS-BK-UNVERIFIED-01",
        parentId: fixtures.parentWithAdminKeyword.id,
        childId: testChild.id,
        providerId: p2Provider.id,
        centerId: p2CenterB.id,
        careType: "DAILY",
        startTime: new Date(Date.now() + 86_400_000),
        endTime: new Date(Date.now() + 2 * 86_400_000),
        status: "REQUESTED",
        totalAmount: "150.00",
        paymentStatus: "PENDING",
      })
      .returning();

    const failConfirmBookingOnUnverifiedCenter = await dispatchAdminApiRequest({
      method: "PATCH",
      segments: ["bookings", unverifiedCenterBooking.id, "status"],
      query: {},
      body: {
        status: "CONFIRMED",
        reason: "Attempting to confirm booking on unverified centre",
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(failConfirmBookingOnUnverifiedCenter.status, 400);

    console.log(
      "    [PASS] Independent centre & caregiver verification workflows and booking gates verified."
    );

    console.log(
      "F4. Testing Atomic Database Transactions, Rollback on Failure & Concurrency Conflict (409)..."
    );

    // Transaction Test 2: Concurrent/duplicate approval of already-approved p2CenterA returns 409 Conflict
    const duplicateCenterApproveRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["center-verifications", p2CenterA.id, "approve"],
      query: {},
      body: {
        reviewComments: "Duplicate concurrent approval attempt",
        checklistState: {
          operatingLicenseVerified: true,
          facilitySafetyVerified: true,
          caregiverQualificationVerified: true,
          capacityVerified: true,
          operatingHoursVerified: true,
          ageGroupsVerified: true,
        },
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(duplicateCenterApproveRes.status, 409);

    // Transaction Test 1: Simulated failure inside db.transaction rolls back all changes atomically
    // Inject a failure on `verificationReviewHistory` insert during rejecting p2CenterB
    setFailNextInsertOnTable(verificationReviewHistory);
    const failedTxRejectRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["center-verifications", p2CenterB.id, "reject"],
      query: {},
      body: {
        rejectionReason: "Testing transaction rollback when history insert fails",
        reviewComments: "Should roll back centre status change",
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase2VerificationTest/1.0",
    });
    assert.equal(failedTxRejectRes.status, 500);

    const centersAfterRollback = await memoryDb.select().from(centers);
    const centerBAfterRollback = centersAfterRollback.find(
      (c) => c.id === p2CenterB.id
    )!;
    assert.equal(
      centerBAfterRollback.verificationStatus,
      "PENDING",
      "Center status must roll back to PENDING when transaction fails mid-flight"
    );
    assert.equal(
      centerBAfterRollback.listingStatus,
      "PENDING_APPROVAL",
      "Center listingStatus must roll back to PENDING_APPROVAL when transaction fails mid-flight"
    );

    // Verify review history records match committed decisions
    const committedHistoryRows = await memoryDb
      .select()
      .from(verificationReviewHistory);
    assert.ok(
      committedHistoryRows.length >= 4,
      "Committed verification decisions must be recorded in verification_review_history"
    );

    console.log(
      "    [PASS] Atomic transaction rollback, 409 conflict detection, and review history consistency verified."
    );

    // ========================================================================
    // PART G: Phase 2.1 Document Security, Evidence Scoping & Hardening Tests
    // ========================================================================
    console.log(
      "G1. Testing Phase 2.1 Malware Scan Defaults, Constraints & Database Config..."
    );

    // 1. Default malwareScanStatus MUST be PENDING (never SAFE/CLEAN)
    assert.equal(
      verificationDocuments.malwareScanStatus.default,
      "PENDING",
      "verificationDocuments.malwareScanStatus must default to PENDING"
    );

    // 2. Phase 2.1 CHECK constraints on verification_documents
    const p21DocCheckNames = getTableConfig(verificationDocuments).checks.map(
      (c) => c.name
    );
    assert.ok(p21DocCheckNames.includes("verification_documents_size_max"));
    assert.ok(
      p21DocCheckNames.includes("verification_documents_malware_status_valid")
    );
    assert.ok(
      p21DocCheckNames.includes("verification_documents_category_valid")
    );

    // 3. No hardcoded DB fallback & prod/test separation
    assert.throws(
      () =>
        resolveDatabaseConnectionString({
          NODE_ENV: "development",
        } as unknown as NodeJS.ProcessEnv),
      DatabaseConfigurationError,
      "Missing DATABASE_URL must fail loudly without hardcoded fallback"
    );
    assert.throws(
      () =>
        resolveDatabaseConnectionString({
          NODE_ENV: "production",
          DATABASE_URL: "postgresql://user:pass@ep.neon.tech/prod",
          TEST_DATABASE_URL: "postgresql://user:pass@ep.neon.tech/prod",
        } as unknown as NodeJS.ProcessEnv),
      DatabaseConfigurationError,
      "Production must reject matching TEST_DATABASE_URL"
    );
    assert.throws(
      () =>
        resolveDatabaseConnectionString({
          NODE_ENV: "test",
          DATABASE_URL: "postgresql://user:pass@ep.neon.tech/prod",
        } as unknown as NodeJS.ProcessEnv),
      DatabaseConfigurationError,
      "Test mode must require dedicated TEST_DATABASE_URL instead of DATABASE_URL"
    );

    console.log(
      "    [PASS] Phase 2.1 defaults, document constraints, and DB URL guards verified."
    );

    console.log(
      "G2. Testing Private Document Upload, Malware Scanning, Quarantine & Content Access Control..."
    );

    // Clear CLAMAV env vars to ensure fail-safe PENDING behavior when unconfigured
    const origClamHost = process.env.CLAMAV_HOST;
    delete process.env.CLAMAV_HOST;
    setDocumentScannerForTests(null);

    // Authenticate a distinct independent reviewer admin (superAdmin) so uploader vs reviewer separation of duties is enforced
    resetAllRateLimitsForTests();
    await memoryDb
      .update(adminOtpChallenges)
      .set({ invalidatedAt: new Date() })
      .where(undefined);
    const revOtpReq = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "request-otp"],
      query: {},
      body: { email: fixtures.superAdmin.email },
      cookies: {},
      headers: {},
      ipAddress: "10.30.0.2",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(revOtpReq.status, 200);
    const revOtpCode = interceptedEmails.at(-1)!.otpCode;
    const revVerifyRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "verify-otp"],
      query: {},
      body: { email: fixtures.superAdmin.email, otp: revOtpCode },
      cookies: {},
      headers: {},
      ipAddress: "10.30.0.2",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(revVerifyRes.status, 200);
    const reviewerCookies = Object.fromEntries(
      (revVerifyRes.cookiesToSet ?? []).map((c: CookieInstruction) => [
        c.name,
        c.value,
      ])
    );
    const reviewerHeaders = {
      [ADMIN_CSRF_HEADER_NAME]: reviewerCookies[ADMIN_CSRF_COOKIE_NAME],
      host: "localhost:3000",
      origin: "http://localhost:3000",
    };

    // 1. Forged MIME/magic signature rejected (executable bytes claiming PDF)
    const exePayload = Buffer.from("MZ\x90\x00\x03\x00\x00\x00fake-exe", "binary");
    const forgedUploadRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", "upload"],
      query: {},
      body: {
        providerId: p2Provider.id,
        centerId: null,
        caregiverId: null,
        documentCategory: "PROVIDER",
        documentType: "TAX_COMPLIANCE_CERT",
        documentTitle: "Spoofed Executable",
        fileName: "malware.pdf",
        mimeType: "application/pdf",
        fileBase64: exePayload.toString("base64"),
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(forgedUploadRes.status, 400);

    // 2. Valid PDF upload succeeds into private storage with PENDING status (never auto-CLEAN)
    const uploadPendingRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", "upload"],
      query: {},
      body: {
        providerId: p2Provider.id,
        centerId: null,
        caregiverId: null,
        documentCategory: "PROVIDER",
        documentType: "INSURANCE_CERTIFICATE",
        documentTitle: "Liability Insurance Certificate 2026",
        fileName: "../etc/passwd/insurance-2026.pdf",
        mimeType: "application/pdf",
        fileBase64: samplePdfBytes.toString("base64"),
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(uploadPendingRes.status, 201);
    const pendingDocId = (
      uploadPendingRes.body.data as {
        documentId: string;
        malwareScanStatus: string;
      }
    ).documentId;
    assert.equal(
      (uploadPendingRes.body.data as { malwareScanStatus: string })
        .malwareScanStatus,
      "PENDING",
      "Unconfigured malware scanner must keep uploaded documents PENDING, never CLEAN"
    );

    // 3a. Uploader cannot self-verify their own uploaded document (403)
    const failSelfVerifyDoc = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", pendingDocId, "approve"],
      query: {},
      body: {
        reviewNotes: "Attempting self-approval of uploaded doc",
        evidenceReviewed: true,
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(failSelfVerifyDoc.status, 403);

    // 3b. Independent reviewer cannot approve PENDING/unscanned document (400) & strict schema rejects forged fields / missing evidenceReviewed
    const failApprovePending = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", pendingDocId, "approve"],
      query: {},
      body: {
        reviewNotes: "Attempting approval before malware scan",
        evidenceReviewed: true,
      },
      cookies: reviewerCookies,
      headers: reviewerHeaders,
      ipAddress: "10.30.0.2",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(failApprovePending.status, 400);

    const failMissingEvidenceFlag = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", pendingDocId, "approve"],
      query: {},
      body: {
        reviewNotes: "Missing inspection checkbox",
      },
      cookies: reviewerCookies,
      headers: reviewerHeaders,
      ipAddress: "10.30.0.2",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(failMissingEvidenceFlag.status, 400);

    const failForgedScanField = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", pendingDocId, "approve"],
      query: {},
      body: {
        reviewNotes: "Attempting client spoof of malwareScanStatus",
        evidenceReviewed: true,
        malwareScanStatus: "CLEAN",
      },
      cookies: reviewerCookies,
      headers: reviewerHeaders,
      ipAddress: "10.30.0.2",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(failForgedScanField.status, 400);

    // 4. Content streaming blocked while PENDING
    const failStreamPending = await handleDocumentContentStreamRequest(
      {
        method: "GET",
        segments: ["verification-documents", pendingDocId, "content"],
        query: {},
        body: undefined,
        cookies: reviewerCookies,
        headers: {},
        ipAddress: "10.30.0.2",
        userAgent: "Phase21Test/1.0",
      },
      pendingDocId
    );
    assert.equal(failStreamPending.ok, false);
    if (!failStreamPending.ok) {
      assert.equal(failStreamPending.response.status, 403);
    }

    // 5. Infected document scan -> quarantines, rejects, blocks rescan, blocks approval, blocks content access
    const uploadInfectedRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", "upload"],
      query: {},
      body: {
        providerId: p2Provider.id,
        centerId: p2CenterB.id,
        caregiverId: null,
        documentCategory: "CENTER",
        documentType: "HEALTH_INSPECTION",
        documentTitle: "Infected Health Attachment",
        fileName: "eicar-test.pdf",
        mimeType: "application/pdf",
        fileBase64: samplePdfBytes.toString("base64"),
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(uploadInfectedRes.status, 201);
    const infectedDocId = (
      uploadInfectedRes.body.data as { documentId: string }
    ).documentId;

    setDocumentScannerForTests(async () => ({
      status: "INFECTED",
      provider: "clamav-test",
      scannedAt: new Date(),
      resultMessage: "Eicar-Test-Signature FOUND",
      configured: true,
    }));

    const infectedScanRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", infectedDocId, "scan"],
      query: {},
      body: {},
      cookies: reviewerCookies,
      headers: reviewerHeaders,
      ipAddress: "10.30.0.2",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(infectedScanRes.status, 200);
    assert.equal(
      (infectedScanRes.body.data as { malwareScanStatus: string })
        .malwareScanStatus,
      "INFECTED"
    );

    const failRescanInfected = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", infectedDocId, "scan"],
      query: {},
      body: {},
      cookies: reviewerCookies,
      headers: reviewerHeaders,
      ipAddress: "10.30.0.2",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(failRescanInfected.status, 403);

    const failApproveInfected = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", infectedDocId, "approve"],
      query: {},
      body: {
        reviewNotes: "Attempting infected approval",
        evidenceReviewed: true,
      },
      cookies: reviewerCookies,
      headers: reviewerHeaders,
      ipAddress: "10.30.0.2",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(failApproveInfected.status, 400);

    const failStreamInfected = await handleDocumentContentStreamRequest(
      {
        method: "GET",
        segments: ["verification-documents", infectedDocId, "content"],
        query: {},
        body: undefined,
        cookies: reviewerCookies,
        headers: {},
        ipAddress: "10.30.0.2",
        userAgent: "Phase21Test/1.0",
      },
      infectedDocId
    );
    assert.equal(failStreamInfected.ok, false);
    if (!failStreamInfected.ok) {
      assert.equal(failStreamInfected.response.status, 403);
    }

    // 6. Clean scan -> signed preview URL -> authenticated streaming & audit logging -> approval succeeds
    setDocumentScannerForTests(async () => ({
      status: "CLEAN",
      provider: "clamav-test",
      scannedAt: new Date(),
      resultMessage: "stream: OK",
      configured: true,
    }));

    const cleanScanRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", pendingDocId, "scan"],
      query: {},
      body: {},
      cookies: reviewerCookies,
      headers: reviewerHeaders,
      ipAddress: "10.30.0.2",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(cleanScanRes.status, 200);
    assert.equal(
      (cleanScanRes.body.data as { malwareScanStatus: string })
        .malwareScanStatus,
      "CLEAN"
    );

    const inspectedRes = await dispatchAdminApiRequest({
      method: "GET",
      segments: ["verification-documents", pendingDocId],
      query: {},
      body: undefined,
      cookies: reviewerCookies,
      headers: {},
      ipAddress: "10.30.0.2",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(inspectedRes.status, 200);
    const signedAccessUrl = (
      inspectedRes.body.data as { signedAccessUrl: string | null }
    ).signedAccessUrl;
    assert.ok(
      signedAccessUrl && signedAccessUrl.includes("token="),
      "GET /verification-documents/:id must mint a signedAccessUrl for CLEAN documents"
    );
    assert.equal(
      JSON.stringify(inspectedRes.body).includes("private://"),
      false,
      "GET /verification-documents/:id must never leak storageReference"
    );

    const parsedToken = new URL(
      `http://localhost:3000${signedAccessUrl}`
    ).searchParams.get("token")!;

    // Unauthenticated access blocked (401)
    const unauthStream = await handleDocumentContentStreamRequest(
      {
        method: "GET",
        segments: ["verification-documents", pendingDocId, "content"],
        query: { token: parsedToken },
        body: undefined,
        cookies: {},
        headers: {},
        ipAddress: "10.30.0.2",
        userAgent: "Phase21Test/1.0",
      },
      pendingDocId
    );
    assert.equal(unauthStream.ok, false);
    if (!unauthStream.ok) assert.equal(unauthStream.response.status, 401);

    // Different admin trying to replay reviewerCookies's signed token fails (403)
    const wrongAdminTokenStream = await handleDocumentContentStreamRequest(
      {
        method: "GET",
        segments: ["verification-documents", pendingDocId, "content"],
        query: { token: parsedToken },
        body: undefined,
        cookies: p2Cookies,
        headers: {},
        ipAddress: "10.30.0.1",
        userAgent: "Phase21Test/1.0",
      },
      pendingDocId
    );
    assert.equal(wrongAdminTokenStream.ok, false);
    if (!wrongAdminTokenStream.ok) {
      assert.equal(wrongAdminTokenStream.response.status, 403);
    }

    // Cross-provider ownership check fails (403)
    const crossProviderStream = await handleDocumentContentStreamRequest(
      {
        method: "GET",
        segments: ["verification-documents", pendingDocId, "content"],
        query: { token: parsedToken, providerId: fixtures.provider.id },
        body: undefined,
        cookies: reviewerCookies,
        headers: {},
        ipAddress: "10.30.0.2",
        userAgent: "Phase21Test/1.0",
      },
      pendingDocId
    );
    assert.equal(crossProviderStream.ok, false);
    if (!crossProviderStream.ok) {
      assert.equal(crossProviderStream.response.status, 403);
    }

    // Legitimate authenticated stream succeeds with strict security headers & audit log
    const validStream = await handleDocumentContentStreamRequest(
      {
        method: "GET",
        segments: ["verification-documents", pendingDocId, "content"],
        query: { token: parsedToken },
        body: undefined,
        cookies: reviewerCookies,
        headers: {},
        ipAddress: "10.30.0.2",
        userAgent: "Phase21Test/1.0",
      },
      pendingDocId
    );
    assert.equal(validStream.ok, true);
    if (validStream.ok) {
      assert.equal(validStream.buffer.equals(samplePdfBytes), true);
      assert.equal(validStream.headers["X-Content-Type-Options"], "nosniff");
      assert.equal(
        validStream.headers["Content-Security-Policy"],
        "default-src 'none'; sandbox"
      );
      assert.ok(validStream.headers["Cache-Control"].includes("no-store"));
    }

    // Approve cleanly after inspection
    const approvePendingRes = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", pendingDocId, "approve"],
      query: {},
      body: {
        reviewNotes: "Inspected private PDF stream and verified CLEAN certificate.",
        evidenceReviewed: true,
      },
      cookies: reviewerCookies,
      headers: reviewerHeaders,
      ipAddress: "10.30.0.2",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(approvePendingRes.status, 200);

    // 7. Missing or tampered private storage object blocks approval
    const missingStorageUpload = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", "upload"],
      query: {},
      body: {
        providerId: p2Provider.id,
        centerId: null,
        caregiverId: null,
        documentCategory: "PROVIDER",
        documentType: "BOARD_RESOLUTION",
        documentTitle: "Disappearing Evidence Doc",
        fileName: "vanish.pdf",
        mimeType: "application/pdf",
        fileBase64: samplePdfBytes.toString("base64"),
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(missingStorageUpload.status, 201);
    const vanishDocId = (
      missingStorageUpload.body.data as { documentId: string }
    ).documentId;
    await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", vanishDocId, "scan"],
      query: {},
      body: {},
      cookies: reviewerCookies,
      headers: reviewerHeaders,
      ipAddress: "10.30.0.2",
      userAgent: "Phase21Test/1.0",
    });
    // Wipe backing private object before approval
    inMemoryDocumentObjects.clear();
    const failMissingContent = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verification-documents", vanishDocId, "approve"],
      query: {},
      body: {
        reviewNotes: "Should fail because stored bytes vanished",
        evidenceReviewed: true,
      },
      cookies: reviewerCookies,
      headers: reviewerHeaders,
      ipAddress: "10.30.0.2",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(failMissingContent.status, 400);

    // 8. Historical unscanned CLEAN diagnostic report is strictly read-only
    const legacyImpact = await inspectHistoricalCleanDocumentsImpact();
    assert.equal(typeof legacyImpact.totalDocuments, "number");
    assert.equal(typeof legacyImpact.quarantinedCount, "number");
    assert.ok(legacyImpact.quarantinedCount >= 1);

    if (origClamHost !== undefined) process.env.CLAMAV_HOST = origClamHost;

    console.log(
      "    [PASS] Document upload, MIME sniffing, malware quarantine, signed preview, streaming & approval guards verified."
    );

    console.log(
      "G3. Testing Strict Evidence Scoping & Mandatory Checklist Enforcement..."
    );

    // Create provider with ONLY a verified/CLEAN centre document (no organization PROVIDER doc)
    const [scopedOwner] = await memoryDb
      .insert(users)
      .values({
        email: "scoped.owner@example.com",
        name: "Scoped Owner",
        role: "PROVIDER",
        status: "ACTIVE",
      })
      .returning();
    const [scopedProv] = await memoryDb
      .insert(providers)
      .values({
        ownerUserId: scopedOwner.id,
        organizationName: "Scoped Childcare Org",
        registrationNumber: "REG-SCOPED-1",
        contactEmail: "scoped@example.com",
        contactPhone: "555-0900",
        address: "1 Scope St",
        city: "Austin",
        state: "TX",
        postalCode: "78702",
        verificationStatus: "PENDING",
        subscriptionActive: true,
        isPublished: false,
      })
      .returning();
    const [scopedCenter] = await memoryDb
      .insert(centers)
      .values({
        providerId: scopedProv.id,
        name: "Scoped Campus",
        slug: "scoped-campus",
        address: "1 Scope St",
        city: "Austin",
        state: "TX",
        postalCode: "78702",
        phone: "555-0901",
        email: "campus@example.com",
        approvedCapacity: 12,
        ageGroupsSupported: ["Infant"],
        operatingHours: { mon: { open: "08:00", close: "18:00" } },
      })
      .returning();
    await memoryDb.insert(verificationDocuments).values({
      providerId: scopedProv.id,
      centerId: scopedCenter.id,
      caregiverId: null,
      documentCategory: "CENTER",
      documentType: "FIRE_SAFETY_PERMIT",
      documentTitle: "Center-only Fire Permit",
      storageReference: "private://scoped/fire.pdf",
      originalFileName: "fire.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: samplePdfBytes.byteLength,
      checksumSha256: samplePdfSha256,
      malwareScanStatus: "CLEAN",
      malwareScanProvider: "clamav",
      malwareScannedAt: new Date(),
      status: "VERIFIED",
      reviewedBy: fixtures.standardAdmin.id,
      reviewedAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 86_400_000),
      uploadedBy: scopedOwner.id,
    });
    const [scopedVerif] = await memoryDb
      .insert(providerVerifications)
      .values({
        providerId: scopedProv.id,
        status: "PENDING",
        submittedAt: new Date(),
        documentReferences: [],
        checklistState: {},
      })
      .returning();

    const failOrgWithOnlyCenterDoc = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["verifications", scopedVerif.id, "approve"],
      query: {},
      body: {
        reviewComments: "Attempting org approval with center doc only",
        checklistState: {
          licenseVerified: true,
          organizationDetailsVerified: true,
        },
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(
      failOrgWithOnlyCenterDoc.status,
      400,
      "Centre-scoped document must NEVER satisfy organization-level provider approval"
    );

    assert.equal(
      isProviderScopedDocument({
        centerId: scopedCenter.id,
        caregiverId: null,
        documentCategory: "CENTER",
      }),
      false
    );
    assert.equal(
      isCenterScopedDocument(
        {
          providerId: fixtures.provider.id,
          centerId: scopedCenter.id,
          caregiverId: null,
          documentCategory: "CENTER",
        },
        scopedCenter.id,
        scopedProv.id
      ),
      false
    );

    // Incomplete center checklist rejected by strict validation
    const failIncompleteCenterChecklist = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["center-verifications", scopedCenter.id, "approve"],
      query: {},
      body: {
        reviewComments: "Incomplete 4-key checklist",
        checklistState: {
          operatingLicenseVerified: true,
          facilitySafetyVerified: true,
          caregiverQualificationVerified: true,
          capacityVerified: true,
        },
      },
      cookies: p2Cookies,
      headers: p2Headers,
      ipAddress: "10.30.0.1",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(failIncompleteCenterChecklist.status, 400);

    console.log(
      "    [PASS] Strict document ownership scoping and mandatory complete checklists verified."
    );

    console.log(
      "G4. Testing Atomic OTP Login Rollback & Audit Transaction Atomicity..."
    );

    // Expire cooldown/challenges for standardAdmin and request fresh OTP
    resetAllRateLimitsForTests();
    await memoryDb
      .update(adminOtpChallenges)
      .set({ invalidatedAt: new Date() })
      .where(undefined);

    const txOtpReq = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "request-otp"],
      query: {},
      body: { email: "admin@littlesteps.com" },
      cookies: {},
      headers: {},
      ipAddress: "10.30.0.99",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(txOtpReq.status, 200);
    const txOtpCode = interceptedEmails.at(-1)!.otpCode;

    // Count existing ADMIN_LOGIN_SUCCESS audit logs before failure
    const logsBeforeOtpFail = (
      await memoryDb.select().from(adminAuditLogs)
    ).filter((l) => l.action === "ADMIN_LOGIN_SUCCESS").length;

    // Inject failure into adminSessions insert during OTP verify
    setFailNextInsertOnTable(adminSessions);
    const failedOtpVerify = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "verify-otp"],
      query: {},
      body: { email: "admin@littlesteps.com", otp: txOtpCode },
      cookies: {},
      headers: {},
      ipAddress: "10.30.0.99",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(failedOtpVerify.status, 500);

    const logsAfterOtpFail = (
      await memoryDb.select().from(adminAuditLogs)
    ).filter((l) => l.action === "ADMIN_LOGIN_SUCCESS").length;
    assert.equal(
      logsAfterOtpFail,
      logsBeforeOtpFail,
      "Failed login transaction must roll back ADMIN_LOGIN_SUCCESS audit log"
    );

    // Retrying with the SAME valid OTP succeeds because consumedAt was rolled back!
    const recoveredOtpVerify = await dispatchAdminApiRequest({
      method: "POST",
      segments: ["auth", "verify-otp"],
      query: {},
      body: { email: "admin@littlesteps.com", otp: txOtpCode },
      cookies: {},
      headers: {},
      ipAddress: "10.30.0.99",
      userAgent: "Phase21Test/1.0",
    });
    assert.equal(
      recoveredOtpVerify.status,
      200,
      "Rolled-back OTP consumption must allow legitimate retry once DB recovers"
    );

    console.log(
      "    [PASS] Atomic OTP consumption + session + audit rollback verified."
    );

    console.log(
      "G5. Testing Rate Limiter Lock Cleanup, Single-Call Redis Lua EVAL & SQL Upsert..."
    );

    // Concurrent memory rate limit burst leaves zero dangling key locks
    resetAllRateLimitsForTests();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        checkRateLimit(`burst:ip-${i % 4}`, 10, 60_000)
      )
    );
    assert.equal(
      getActiveKeyLockCountForTests(),
      0,
      "withKeyLock must clean up all promise entries after concurrent completions"
    );

    // Atomic Redis Lua EVAL + Production fail-closed check
    const origFetch = globalThis.fetch;
    const origUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
    const origUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const mutableEnv = process.env as Record<string, string | undefined>;
    const origNodeEnv = mutableEnv.NODE_ENV;
    let redisEvalRequests = 0;

    try {
      setRateLimitBackendForTests("redis");
      process.env.UPSTASH_REDIS_REST_URL = "https://mock-upstash.example.com";
      process.env.UPSTASH_REDIS_REST_TOKEN = "mock-token";

      globalThis.fetch = (async (_input, init) => {
        redisEvalRequests += 1;
        const body = JSON.parse(String(init?.body ?? "[]")) as string[];
        assert.equal(
          body[0],
          "EVAL",
          "Redis rate limiter must issue a single atomic EVAL Lua script call"
        );
        assert.ok(body[1].includes("PEXPIRE"));
        return new Response(JSON.stringify({ result: [1, 60_000] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const redisOk = await checkRateLimit("redis-test:1", 5, 60_000);
      assert.equal(redisOk.allowed, true);
      assert.equal(redisEvalRequests, 1);

      // Simulate Redis outage under production -> MUST fail closed (allowed: false)
      mutableEnv.NODE_ENV = "production";
      globalThis.fetch = (async () =>
        new Response("Redis Down", { status: 503 })) as typeof fetch;
      const redisFailClosed = await checkRateLimit("redis-test:2", 5, 60_000);
      assert.equal(
        redisFailClosed.allowed,
        false,
        "Production rate limiter must fail closed when Redis is unavailable"
      );
    } finally {
      mutableEnv.NODE_ENV = origNodeEnv;
      globalThis.fetch = origFetch;
      if (origUpstashUrl !== undefined) {
        process.env.UPSTASH_REDIS_REST_URL = origUpstashUrl;
      } else {
        delete process.env.UPSTASH_REDIS_REST_URL;
      }
      if (origUpstashToken !== undefined) {
        process.env.UPSTASH_REDIS_REST_TOKEN = origUpstashToken;
      } else {
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
      }
      setRateLimitBackendForTests("database");
    }

    // Atomic SQL upsert path check (`db.execute` called once per rate-limit check)
    let pgUpsertCalls = 0;
    let pgCounter = 0;
    try {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      setDatabaseInstanceForTests({
        execute: async () => {
          pgUpsertCalls += 1;
          pgCounter += 1;
          return {
            rows: [
              {
                setting_value: {
                  count: pgCounter,
                  resetAt: Date.now() + 60_000,
                },
              },
            ],
          };
        },
      } as unknown as AppDatabase);

      const pgRes1 = await checkRateLimit("sql-atomic:1", 1, 60_000);
      const pgRes2 = await checkRateLimit("sql-atomic:1", 1, 60_000);
      assert.equal(pgRes1.allowed, true);
      assert.equal(pgRes2.allowed, false);
      assert.equal(pgUpsertCalls, 2);
    } finally {
      setDatabaseInstanceForTests(memoryDb);
      setRateLimitBackendForTests("memory-test");
      resetAllRateLimitsForTests();
    }

    console.log(
      "    [PASS] Rate limiter lock cleanup, atomic Redis EVAL, prod fail-closed, and SQL upsert verified."
    );

    console.log(
      "=================================================================="
    );
    console.log(
      "ALL PHASE 1, PHASE 2 & PHASE 2.1 TESTS PASSED (100% ISOLATED)!"
    );
    console.log(
      "=================================================================="
    );
  } finally {
    setDocumentScannerForTests(null);
    setDocumentStorageAdapterForTests(null);
    setAdminOtpMailInterceptorForTests(null);
    setRateLimitBackendForTests(null);
    setDatabaseInstanceForTests(null);
    process.env.ADMIN_OTP_HMAC_SECRET = originalOtpSecret;
    process.env.ADMIN_SESSION_SECRET = originalSessionSecret;
  }
}

runPhase1SecurityTestSuite().catch((err) => {
  console.error("Phase 1 security test suite failed:", err);
  process.exit(1);
});
