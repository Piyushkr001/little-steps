import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { type AppDatabase, setDatabaseInstanceForTests } from "../config/db";
import {
  adminAuditLogs,
  adminOtpChallenges,
  adminProfiles,
  adminSessions,
  bookings,
  bookingStatusHistory,
  capacityRules,
  caregivers,
  centers,
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
} from "../config/schema";
import {
  type CookieInstruction,
  dispatchAdminApiRequest,
} from "../server/dispatcher";
import { setAdminOtpMailInterceptorForTests } from "../server/mail/nodemailer";
import {
  resetAllRateLimitsForTests,
  setRateLimitBackendForTests,
} from "../server/middleware/rate-limit";
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
  };

  return {
    db: mockDb as unknown as AppDatabase,
    tables,
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

  const [verification] = await db
    .insert(providerVerifications)
    .values({
      providerId: provider.id,
      status: "PENDING",
      submittedAt: now,
      reviewComments: "Initial submission",
      documentReferences: [],
      checklistState: {},
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
    "Little Steps — Phase 1 Admin Portal Security Hardening Test Suite"
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

  const { db: memoryDb } = createIsolatedMemoryDatabase();
  setDatabaseInstanceForTests(memoryDb);
  setRateLimitBackendForTests("memory-test");
  resetAllRateLimitsForTests();

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

    console.log(
      "=================================================================="
    );
    console.log(
      "ALL PHASE 1 SECURITY HARDENING TESTS PASSED (100% ISOLATED)!"
    );
    console.log(
      "=================================================================="
    );
  } finally {
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
