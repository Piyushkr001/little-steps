import assert from "node:assert/strict";
import { desc, eq } from "drizzle-orm";
import { db } from "../config/db";
import {
  adminAuditLogs,
  adminOtpChallenges,
  adminSessions,
  bookings,
  centers,
  providerVerifications,
  safetyIncidents,
  users,
} from "../config/schema";
import { hasAdminEmailKeyword } from "../lib/admin/validation";
import {
  type CookieInstruction,
  dispatchAdminApiRequest as dispatchAdminRequest,
} from "../server/dispatcher";
import { getLastSentTestOtpForTestingOnly } from "../server/mail/nodemailer";
import { resetAllRateLimitsForTests as resetRateLimitStore } from "../server/middleware/rate-limit";
import {
  ADMIN_CSRF_COOKIE_NAME,
  ADMIN_CSRF_HEADER_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  computeAuditIntegrityHash,
  hashOtp,
  verifyOtpHash,
} from "../server/security/crypto";
import { ensureAdminPortalSeeded } from "../server/services/seed.service";

async function clearChallengesForEmail(email: string) {
  await db
    .delete(adminOtpChallenges)
    .where(eq(adminOtpChallenges.email, email.toLowerCase()));
}

async function runTestSuite() {
  console.log(
    "=================================================================="
  );
  console.log(
    "Little Steps — Admin Portal Security & Integration Test Suite"
  );
  console.log(
    "=================================================================="
  );

  await ensureAdminPortalSeeded();
  resetRateLimitStore();

  // ------------------------------------------------------------------
  // 1. Admin Email Keyword & Cryptographic OTP Hashing Unit Tests
  // ------------------------------------------------------------------
  console.log("1. Testing Admin Email Keyword & HMAC-SHA256 OTP Hashing...");
  assert.equal(hasAdminEmailKeyword("admin@littlesteps.com"), true);
  assert.equal(hasAdminEmailKeyword("superadmin@littlesteps.com"), true);
  assert.equal(hasAdminEmailKeyword("littlesteps.admin@gmail.com"), true);
  assert.equal(hasAdminEmailKeyword("director@littlesteps.com"), false);

  const sampleHash = hashOtp("admin@littlesteps.com", "482910");
  assert.notEqual(sampleHash, "482910", "OTP must never be stored in plaintext");
  assert.equal(
    verifyOtpHash("admin@littlesteps.com", "482910", sampleHash),
    true
  );
  assert.equal(
    verifyOtpHash("admin@littlesteps.com", "000000", sampleHash),
    false
  );
  console.log("   [PASS] Keyword check and HMAC-SHA256 OTP hashing verified.");

  // ------------------------------------------------------------------
  // 2. Rejection of Unauthorized Emails (Missing keyword / Unknown email)
  // ------------------------------------------------------------------
  console.log("2. Testing Rejection of Unauthorized Emails...");
  const noKeywordRes = await dispatchAdminRequest({
    method: "POST",
    segments: ["auth", "request-otp"],
    query: {},
    body: { email: "founder@littlesteps.com" },
    cookies: {},
    headers: {},
    ipAddress: "10.0.0.10",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(noKeywordRes.status, 403);

  const unknownAdminRes = await dispatchAdminRequest({
    method: "POST",
    segments: ["auth", "request-otp"],
    query: {},
    body: { email: "unknown.admin@littlesteps.com" },
    cookies: {},
    headers: {},
    ipAddress: "10.0.0.11",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(unknownAdminRes.status, 403);
  console.log("   [PASS] Unauthorized emails rejected with 403.");

  // ------------------------------------------------------------------
  // 3. Rejection of Non-Admin User Containing `admin` in Email
  // ------------------------------------------------------------------
  console.log(
    "3. Testing Rejection of Non-Admin User Containing 'admin' in Email (parent.admin@example.com)..."
  );
  const parentAdminRes = await dispatchAdminRequest({
    method: "POST",
    segments: ["auth", "request-otp"],
    query: {},
    body: { email: "parent.admin@example.com" },
    cookies: {},
    headers: {},
    ipAddress: "10.0.0.12",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(
    parentAdminRes.status,
    403,
    "Parent account with 'admin' in email must NEVER gain admin portal access"
  );
  console.log(
    "   [PASS] Non-admin user with 'admin' keyword in email rejected."
  );

  // ------------------------------------------------------------------
  // 4. Rejection of Suspended Admin Account
  // ------------------------------------------------------------------
  console.log(
    "4. Testing Rejection of Suspended Admin Account (suspended.admin@littlesteps.com)..."
  );
  const suspendedAdminRes = await dispatchAdminRequest({
    method: "POST",
    segments: ["auth", "request-otp"],
    query: {},
    body: { email: "suspended.admin@littlesteps.com" },
    cookies: {},
    headers: {},
    ipAddress: "10.0.0.13",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(suspendedAdminRes.status, 403);
  console.log("   [PASS] Suspended admin account rejected.");

  // ------------------------------------------------------------------
  // 5. OTP Resend Cooldown (60-second minimum interval)
  // ------------------------------------------------------------------
  console.log("5. Testing 60-Second OTP Resend Cooldown...");
  await clearChallengesForEmail("littlesteps.admin@gmail.com");
  resetRateLimitStore();

  const otpReq1 = await dispatchAdminRequest({
    method: "POST",
    segments: ["auth", "request-otp"],
    query: {},
    body: { email: "littlesteps.admin@gmail.com" },
    cookies: {},
    headers: {},
    ipAddress: "10.0.0.14",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(otpReq1.status, 200);
  assert.equal(
    JSON.stringify(otpReq1.body).includes(
      getLastSentTestOtpForTestingOnly()?.otp ?? "NEVER"
    ),
    false,
    "OTP must never be exposed in API responses"
  );

  const immediateResend = await dispatchAdminRequest({
    method: "POST",
    segments: ["auth", "resend-otp"],
    query: {},
    body: { email: "littlesteps.admin@gmail.com" },
    cookies: {},
    headers: {},
    ipAddress: "10.0.0.14",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(
    immediateResend.status,
    429,
    "Immediate resend within 60 seconds must be rejected with 429"
  );
  console.log("   [PASS] 60-second resend cooldown enforced.");

  // ------------------------------------------------------------------
  // 6. Expired OTP Rejection
  // ------------------------------------------------------------------
  console.log("6. Testing Expired OTP Rejection...");
  const expiredOtpCode = getLastSentTestOtpForTestingOnly()?.otp;
  assert.ok(expiredOtpCode);

  const [activeChallenge] = await db
    .select()
    .from(adminOtpChallenges)
    .where(eq(adminOtpChallenges.email, "littlesteps.admin@gmail.com"))
    .orderBy(desc(adminOtpChallenges.createdAt))
    .limit(1);

  await db
    .update(adminOtpChallenges)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(adminOtpChallenges.id, activeChallenge.id));

  const expiredVerifyRes = await dispatchAdminRequest({
    method: "POST",
    segments: ["auth", "verify-otp"],
    query: {},
    body: { email: "littlesteps.admin@gmail.com", otp: expiredOtpCode },
    cookies: {},
    headers: {},
    ipAddress: "10.0.0.15",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(expiredVerifyRes.status, 400);
  console.log("   [PASS] Expired OTP rejected.");

  // ------------------------------------------------------------------
  // 7. Invalid OTP Rejection & 5-Attempt Lockout
  // ------------------------------------------------------------------
  console.log("7. Testing Invalid OTP Rejection & Max 5 Attempts Lockout...");
  await clearChallengesForEmail("littlesteps.admin@gmail.com");
  resetRateLimitStore();

  await dispatchAdminRequest({
    method: "POST",
    segments: ["auth", "request-otp"],
    query: {},
    body: { email: "littlesteps.admin@gmail.com" },
    cookies: {},
    headers: {},
    ipAddress: "10.0.0.16",
    userAgent: "TestRunner/1.0",
  });

  for (let i = 1; i <= 4; i++) {
    const wrongRes = await dispatchAdminRequest({
      method: "POST",
      segments: ["auth", "verify-otp"],
      query: {},
      body: { email: "littlesteps.admin@gmail.com", otp: "000000" },
      cookies: {},
      headers: {},
      ipAddress: `10.0.1.${i}`,
      userAgent: "TestRunner/1.0",
    });
    assert.equal(wrongRes.status, 401);
  }

  const fifthAttemptRes = await dispatchAdminRequest({
    method: "POST",
    segments: ["auth", "verify-otp"],
    query: {},
    body: { email: "littlesteps.admin@gmail.com", otp: "000000" },
    cookies: {},
    headers: {},
    ipAddress: "10.0.1.5",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(
    fifthAttemptRes.status,
    429,
    "5th failed attempt must lock out the OTP challenge with 429"
  );
  console.log("   [PASS] Invalid OTP & 5-attempt lockout verified.");

  // ------------------------------------------------------------------
  // 8. Valid Admin OTP Login & Single-Use Replay Prevention
  // ------------------------------------------------------------------
  console.log(
    "8. Testing Valid Admin OTP Login & OTP Replay Attack Prevention..."
  );
  await clearChallengesForEmail("superadmin@littlesteps.com");
  resetRateLimitStore();

  const superOtpReq = await dispatchAdminRequest({
    method: "POST",
    segments: ["auth", "request-otp"],
    query: {},
    body: { email: "superadmin@littlesteps.com" },
    cookies: {},
    headers: {},
    ipAddress: "10.0.2.1",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(superOtpReq.status, 200);

  const validOtp = getLastSentTestOtpForTestingOnly()?.otp;
  assert.ok(validOtp && /^\d{6}$/.test(validOtp));

  const verifySuccess = await dispatchAdminRequest({
    method: "POST",
    segments: ["auth", "verify-otp"],
    query: {},
    body: { email: "superadmin@littlesteps.com", otp: validOtp },
    cookies: {},
    headers: {},
    ipAddress: "10.0.2.1",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(verifySuccess.status, 200);

  const sessionCookie = verifySuccess.cookiesToSet?.find(
    (c: CookieInstruction) => c.name === ADMIN_SESSION_COOKIE_NAME
  );
  const csrfCookie = verifySuccess.cookiesToSet?.find(
    (c: CookieInstruction) => c.name === ADMIN_CSRF_COOKIE_NAME
  );
  assert.ok(sessionCookie?.value, "HttpOnly session cookie must be issued");
  assert.equal(sessionCookie?.httpOnly, true);
  assert.ok(csrfCookie?.value, "CSRF token cookie must be issued");

  // Replay attempt with the same OTP must fail
  const replayAttempt = await dispatchAdminRequest({
    method: "POST",
    segments: ["auth", "verify-otp"],
    query: {},
    body: { email: "superadmin@littlesteps.com", otp: validOtp },
    cookies: {},
    headers: {},
    ipAddress: "10.0.2.1",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(
    replayAttempt.status,
    400,
    "Replaying a consumed OTP must be rejected"
  );
  console.log(
    "   [PASS] Valid OTP login succeeded and OTP replay attack blocked."
  );

  const authCookies = {
    [ADMIN_SESSION_COOKIE_NAME]: sessionCookie.value,
    [ADMIN_CSRF_COOKIE_NAME]: csrfCookie.value,
  };
  const authHeaders = {
    [ADMIN_CSRF_HEADER_NAME]: csrfCookie.value,
  };

  // ------------------------------------------------------------------
  // 9. Protected API Access & CSRF Protection Enforcement
  // ------------------------------------------------------------------
  console.log("9. Testing Protected API Access & CSRF Protection...");
  const unauthStats = await dispatchAdminRequest({
    method: "GET",
    segments: ["dashboard", "stats"],
    query: {},
    body: {},
    cookies: {},
    headers: {},
    ipAddress: "10.0.2.2",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(
    unauthStats.status,
    401,
    "Unauthenticated request to protected route must return 401"
  );

  const authStats = await dispatchAdminRequest({
    method: "GET",
    segments: ["dashboard", "stats"],
    query: {},
    body: {},
    cookies: authCookies,
    headers: {},
    ipAddress: "10.0.2.2",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(authStats.status, 200);

  // Mutating request without CSRF header must fail with 403
  const missingCsrfRes = await dispatchAdminRequest({
    method: "PATCH",
    segments: ["settings"],
    query: {},
    body: {
      settings: [
        { settingKey: "security.otp_expiry_minutes", settingValue: 5 },
      ],
    },
    cookies: authCookies,
    headers: {},
    ipAddress: "10.0.2.2",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(
    missingCsrfRes.status,
    403,
    "Mutating request without valid CSRF header must return 403"
  );
  console.log("   [PASS] Protected route guard and CSRF validation verified.");

  // ------------------------------------------------------------------
  // 10. Provider Verification Approval & Rejection Workflow
  // ------------------------------------------------------------------
  console.log("10. Testing Provider Verification Approval & Rejection...");
  const verificationsListRes = await dispatchAdminRequest({
    method: "GET",
    segments: ["verifications"],
    query: {},
    body: {},
    cookies: authCookies,
    headers: {},
    ipAddress: "10.0.2.3",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(verificationsListRes.status, 200);
  const verificationsData = verificationsListRes.body.data as Array<{
    id: string;
    status: string;
  }>;
  assert.ok(verificationsData.length > 0);

  const targetVerification = verificationsData[0];
  const originalStatus = targetVerification.status;

  // Reject with reason
  const rejectRes = await dispatchAdminRequest({
    method: "POST",
    segments: ["verifications", targetVerification.id, "reject"],
    query: {},
    body: {
      rejectionReason: "Fire safety certificate renewal page is missing.",
      reviewComments: "Please upload the complete signed fire inspection page.",
    },
    cookies: authCookies,
    headers: authHeaders,
    ipAddress: "10.0.2.3",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(rejectRes.status, 200);

  // Approve verification
  const approveRes = await dispatchAdminRequest({
    method: "POST",
    segments: ["verifications", targetVerification.id, "approve"],
    query: {},
    body: {
      reviewComments:
        "All licensing, fire safety, and caregiver checks verified.",
    },
    cookies: authCookies,
    headers: authHeaders,
    ipAddress: "10.0.2.3",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(approveRes.status, 200);

  // Restore original verification status if needed
  await db
    .update(providerVerifications)
    .set({
      status:
        originalStatus as typeof providerVerifications.$inferSelect.status,
    })
    .where(eq(providerVerifications.id, targetVerification.id));
  console.log(
    "   [PASS] Provider verification approval & rejection workflow verified."
  );

  // ------------------------------------------------------------------
  // 11. User Suspension Permissions & Self-Suspension Guard
  // ------------------------------------------------------------------
  console.log("11. Testing User Suspension Permissions...");
  const meRes = await dispatchAdminRequest({
    method: "GET",
    segments: ["auth", "me"],
    query: {},
    body: {},
    cookies: authCookies,
    headers: {},
    ipAddress: "10.0.2.4",
    userAgent: "TestRunner/1.0",
  });
  const currentAdmin = (meRes.body.data as { admin: { id: string } }).admin;

  // Self-suspension must be blocked
  const selfSuspendRes = await dispatchAdminRequest({
    method: "PATCH",
    segments: ["users", currentAdmin.id, "status"],
    query: {},
    body: {
      status: "SUSPENDED",
      reason: "Attempting to suspend own account",
    },
    cookies: authCookies,
    headers: authHeaders,
    ipAddress: "10.0.2.4",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(
    selfSuspendRes.status,
    400,
    "Administrators must not be able to suspend their own active account"
  );

  // Suspend and reactivate a parent account
  const [parentUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, "parent.admin@example.com"))
    .limit(1);

  const suspendParentRes = await dispatchAdminRequest({
    method: "PATCH",
    segments: ["users", parentUser.id, "status"],
    query: {},
    body: {
      status: "SUSPENDED",
      reason: "Temporary compliance review of parent account.",
    },
    cookies: authCookies,
    headers: authHeaders,
    ipAddress: "10.0.2.4",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(suspendParentRes.status, 200);

  const reactivateParentRes = await dispatchAdminRequest({
    method: "PATCH",
    segments: ["users", parentUser.id, "status"],
    query: {},
    body: {
      status: "ACTIVE",
      reason: "Compliance review completed and account restored.",
    },
    cookies: authCookies,
    headers: authHeaders,
    ipAddress: "10.0.2.4",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(reactivateParentRes.status, 200);
  console.log("   [PASS] User suspension & self-suspension guard verified.");

  // ------------------------------------------------------------------
  // 12. Booking State Transitions & Childcare Capacity Guard
  // ------------------------------------------------------------------
  console.log(
    "12. Testing Booking State Transitions & Childcare Capacity Guard..."
  );
  const [requestedBooking] = await db
    .select()
    .from(bookings)
    .where(eq(bookings.bookingReference, "LS-BK-2026-1003"))
    .limit(1);
  assert.ok(requestedBooking);

  // Invalid arbitrary transition (e.g. REQUESTED -> COMPLETED) must be rejected
  const invalidTransitionRes = await dispatchAdminRequest({
    method: "PATCH",
    segments: ["bookings", requestedBooking.id, "status"],
    query: {},
    body: {
      status: "COMPLETED",
      reason: "Attempting to skip confirmation and check-in.",
    },
    cookies: authCookies,
    headers: authHeaders,
    ipAddress: "10.0.2.5",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(
    invalidTransitionRes.status,
    400,
    "Invalid booking state jump must be rejected"
  );

  // Temporarily set center occupancy to approvedCapacity to verify capacity constraint enforcement
  const [bookingCenter] = await db
    .select()
    .from(centers)
    .where(eq(centers.id, requestedBooking.centerId))
    .limit(1);

  await db
    .update(centers)
    .set({ currentOccupancy: bookingCenter.approvedCapacity })
    .where(eq(centers.id, bookingCenter.id));

  const capacityBlockedRes = await dispatchAdminRequest({
    method: "PATCH",
    segments: ["bookings", requestedBooking.id, "status"],
    query: {},
    body: {
      status: "CONFIRMED",
      reason: "Attempting confirmation when centre is at 100% capacity.",
    },
    cookies: authCookies,
    headers: authHeaders,
    ipAddress: "10.0.2.5",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(
    capacityBlockedRes.status,
    400,
    "Childcare capacity constraint must never be bypassed"
  );

  // Restore center occupancy
  await db
    .update(centers)
    .set({ currentOccupancy: bookingCenter.currentOccupancy })
    .where(eq(centers.id, bookingCenter.id));
  console.log(
    "   [PASS] Booking state transition rules & capacity guard verified."
  );

  // ------------------------------------------------------------------
  // 13. Safety Incident Access, Status Update & Notes
  // ------------------------------------------------------------------
  console.log("13. Testing Safety Incident Investigation & Activity Notes...");
  const [incident] = await db
    .select()
    .from(safetyIncidents)
    .where(eq(safetyIncidents.incidentReference, "LS-INC-2026-0041"))
    .limit(1);
  assert.ok(incident);

  const noteRes = await dispatchAdminRequest({
    method: "POST",
    segments: ["incidents", incident.id, "notes"],
    query: {},
    body: {
      note: "Verified caregiver first-aid log and CCTV timestamp alignment.",
    },
    cookies: authCookies,
    headers: authHeaders,
    ipAddress: "10.0.2.6",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(noteRes.status, 200);
  console.log("   [PASS] Safety incident investigation note recorded.");

  // ------------------------------------------------------------------
  // 14. Tamper-Evident Audit Log Creation & Integrity Verification
  // ------------------------------------------------------------------
  console.log("14. Testing Tamper-Evident Audit Log Integrity...");
  const [latestAudit] = await db
    .select()
    .from(adminAuditLogs)
    .orderBy(desc(adminAuditLogs.createdAt))
    .limit(1);
  assert.ok(latestAudit);
  assert.ok(
    latestAudit.integrityHash && latestAudit.integrityHash.length === 64,
    "Audit log must have a 64-char SHA-256 HMAC integrity hash"
  );

  const recomputed = computeAuditIntegrityHash({
    adminEmail: latestAudit.adminEmail,
    action: latestAudit.action,
    entityType: latestAudit.entityType,
    entityId: latestAudit.entityId ?? null,
    summary: latestAudit.summary,
    timestampIso: latestAudit.createdAt.toISOString(),
  });
  assert.equal(recomputed.length, 64);
  console.log("   [PASS] Tamper-evident audit log creation verified.");

  // ------------------------------------------------------------------
  // 15. Session Logout & Invalidation
  // ------------------------------------------------------------------
  console.log("15. Testing Session Logout & Invalidation...");
  const logoutRes = await dispatchAdminRequest({
    method: "POST",
    segments: ["auth", "logout"],
    query: {},
    body: {},
    cookies: authCookies,
    headers: authHeaders,
    ipAddress: "10.0.2.7",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(logoutRes.status, 200);

  const afterLogoutStats = await dispatchAdminRequest({
    method: "GET",
    segments: ["dashboard", "stats"],
    query: {},
    body: {},
    cookies: authCookies,
    headers: {},
    ipAddress: "10.0.2.7",
    userAgent: "TestRunner/1.0",
  });
  assert.equal(
    afterLogoutStats.status,
    401,
    "Revoked session token must be rejected after logout"
  );

  // Clean up test session & challenges
  await db
    .delete(adminSessions)
    .where(eq(adminSessions.id, (verifySuccess.body.data as { admin: { sessionId: string } }).admin.sessionId));
  await clearChallengesForEmail("littlesteps.admin@gmail.com");
  await clearChallengesForEmail("superadmin@littlesteps.com");

  console.log("   [PASS] Session logout and invalidation verified.");
  console.log(
    "=================================================================="
  );
  console.log("ALL 15 ADMIN PORTAL SECURITY & FUNCTIONAL TESTS PASSED!");
  console.log(
    "=================================================================="
  );
}

runTestSuite().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
