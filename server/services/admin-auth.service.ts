import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../config/db";
import {
  adminOtpChallenges,
  adminProfiles,
  adminSessions,
  userRoles,
  users,
} from "../../config/schema";
import type { AdminRole, AuthenticatedAdmin } from "../../lib/admin/types";
import { hasAdminEmailKeyword } from "../../lib/admin/validation";
import { sendAdminOtpEmail } from "../mail/nodemailer";
import {
  ADMIN_SESSION_TTL_HOURS,
  generateCsrfToken,
  generateNumericOtp,
  generateSessionToken,
  hashOtp,
  hashSessionToken,
  OTP_EXPIRY_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  verifyOtpHash,
} from "../security/crypto";
import { resolveEffectiveAdminPermissions } from "../security/permissions";
import { recordAdminAuditLog } from "./audit.service";

export class AdminAuthError extends Error {
  statusCode: number;
  code: string;

  constructor(code: string, message: string, statusCode = 401) {
    super(message);
    this.name = "AdminAuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface EligibleAdminRecord {
  user: typeof users.$inferSelect;
  profile: typeof adminProfiles.$inferSelect;
  role: AdminRole;
}

const UNIFORM_ELIGIBILITY_ERROR_MESSAGE =
  "Access denied. This account is not authorized for the Little Steps Admin Portal.";

const inFlightChallengeVerifications = new Set<string>();

/**
 * Strictly validates all 4 pre-OTP Admin Email Eligibility requirements:
 * 1. Email contains keyword `admin` (case-insensitive).
 * 2. Email belongs to an existing, explicitly authorized administrator account (`admin_profiles.is_approved = true`).
 * 3. Account has an active `ADMIN` or `SUPER_ADMIN` role in both `users` and `user_roles`.
 * 4. Account has not been suspended or disabled (`status === "ACTIVE"`).
 *
 * Returns a uniform public 403 error on failure to prevent account enumeration,
 * while recording the specific rejection reason in tamper-evident audit logs.
 */
export async function verifyAdminEligibilityByEmail(
  rawEmail: string,
  auditContext?: {
    ipAddress?: string;
    userAgent?: string;
    recordRejectionAudit?: boolean;
  }
): Promise<EligibleAdminRecord> {
  const email = rawEmail.trim().toLowerCase();

  const rejectEligibility = async (
    internalReason: string,
    userId?: string | null
  ): Promise<never> => {
    if (auditContext?.recordRejectionAudit) {
      await recordAdminAuditLog({
        adminUserId: userId ?? null,
        adminEmail: email || "unknown",
        action: "UNAUTHORIZED_ADMIN_ACCESS_ATTEMPT",
        entityType: "ADMIN_AUTH",
        entityId: userId ?? null,
        summary: `Rejected Admin Portal authentication attempt (${internalReason})`,
        outcome: "DENIED",
        newState: {
          reason: internalReason,
        },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });
    }

    throw new AdminAuthError(
      "ADMIN_ACCESS_DENIED",
      UNIFORM_ELIGIBILITY_ERROR_MESSAGE,
      403
    );
  };

  // Requirement 1: Keyword rule
  if (!hasAdminEmailKeyword(email)) {
    return rejectEligibility("MISSING_ADMIN_EMAIL_KEYWORD");
  }

  const [userRecord] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // Requirement 2: Existing account check
  if (!userRecord) {
    return rejectEligibility("ACCOUNT_NOT_FOUND");
  }

  // Requirement 4: Not suspended or disabled
  if (userRecord.status !== "ACTIVE") {
    return rejectEligibility(
      `ACCOUNT_STATUS_${userRecord.status}`,
      userRecord.id
    );
  }

  // Requirement 3: Active ADMIN or SUPER_ADMIN role
  if (userRecord.role !== "ADMIN" && userRecord.role !== "SUPER_ADMIN") {
    return rejectEligibility(
      `NON_ADMIN_USER_ROLE_${userRecord.role}`,
      userRecord.id
    );
  }

  const activeRoles = await db
    .select()
    .from(userRoles)
    .where(
      and(eq(userRoles.userId, userRecord.id), eq(userRoles.isActive, true))
    );

  const hasActiveAdminRoleAssignment = activeRoles.some(
    (r) => r.role === "ADMIN" || r.role === "SUPER_ADMIN"
  );

  if (!hasActiveAdminRoleAssignment) {
    return rejectEligibility("NO_ACTIVE_ADMIN_ROLE_ASSIGNMENT", userRecord.id);
  }

  // Requirement 2b: Explicit approved admin_profiles entry
  const [profileRecord] = await db
    .select()
    .from(adminProfiles)
    .where(eq(adminProfiles.userId, userRecord.id))
    .limit(1);

  if (!profileRecord || !profileRecord.isApproved) {
    return rejectEligibility("ADMIN_PROFILE_UNAPPROVED", userRecord.id);
  }

  return {
    user: userRecord,
    profile: profileRecord,
    role: userRecord.role as AdminRole,
  };
}

export async function issueAdminOtpChallenge(params: {
  email: string;
  ipAddress?: string;
  userAgent?: string;
  isResend?: boolean;
}): Promise<{
  email: string;
  expiresInSeconds: number;
  resendCooldownSeconds: number;
}> {
  const { user } = await verifyAdminEligibilityByEmail(params.email, {
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    recordRejectionAudit: true,
  });
  const now = new Date();

  // Check if the most recent challenge for this administrator is still within the 60s resend cooldown window
  const [latestChallenge] = await db
    .select()
    .from(adminOtpChallenges)
    .where(
      and(
        eq(adminOtpChallenges.userId, user.id),
        isNull(adminOtpChallenges.consumedAt),
        isNull(adminOtpChallenges.invalidatedAt)
      )
    )
    .orderBy(desc(adminOtpChallenges.createdAt))
    .limit(1);

  if (latestChallenge && latestChallenge.resendAvailableAt > now) {
    const waitSeconds = Math.max(
      1,
      Math.ceil(
        (latestChallenge.resendAvailableAt.getTime() - now.getTime()) / 1000
      )
    );
    throw new AdminAuthError(
      "OTP_RESEND_COOLDOWN",
      `Please wait ${waitSeconds} seconds before requesting another OTP code.`,
      429
    );
  }

  // Invalidate all previous unconsumed OTP challenges for this administrator before issuing a replacement
  await db
    .update(adminOtpChallenges)
    .set({ invalidatedAt: now })
    .where(
      and(
        eq(adminOtpChallenges.userId, user.id),
        isNull(adminOtpChallenges.consumedAt),
        isNull(adminOtpChallenges.invalidatedAt)
      )
    );

  // Always generate a cryptographically random 6-digit OTP (no demo or fixed OTPs)
  const rawOtp = generateNumericOtp();
  const otpHash = hashOtp(user.email, rawOtp);
  const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MINUTES * 60_000);
  const resendAvailableAt = new Date(
    now.getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1_000
  );

  const [createdChallenge] = await db
    .insert(adminOtpChallenges)
    .values({
      userId: user.id,
      email: user.email,
      otpHash,
      expiresAt,
      attempts: 0,
      maxAttempts: OTP_MAX_ATTEMPTS,
      resendAvailableAt,
      resendCount: params.isResend
        ? (latestChallenge?.resendCount ?? 0) + 1
        : 0,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    })
    .returning({ id: adminOtpChallenges.id });

  try {
    await sendAdminOtpEmail({
      toEmail: user.email,
      adminName: user.name,
      otpCode: rawOtp,
      ipAddress: params.ipAddress,
    });
  } catch (deliveryError) {
    // Invalidate the challenge immediately if email delivery fails so no undelivered active OTP remains
    await db
      .update(adminOtpChallenges)
      .set({ invalidatedAt: new Date() })
      .where(eq(adminOtpChallenges.id, createdChallenge.id));

    await recordAdminAuditLog({
      adminUserId: user.id,
      adminEmail: user.email,
      action: "ADMIN_OTP_DELIVERY_FAILED",
      entityType: "ADMIN_AUTH",
      entityId: createdChallenge.id,
      summary: `Failed to deliver 6-digit OTP email to ${user.email}`,
      outcome: "FAILURE",
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });

    throw deliveryError;
  }

  await recordAdminAuditLog({
    adminUserId: user.id,
    adminEmail: user.email,
    action: params.isResend ? "ADMIN_OTP_RESENT" : "ADMIN_OTP_REQUESTED",
    entityType: "ADMIN_AUTH",
    entityId: createdChallenge.id,
    summary: params.isResend
      ? `Replacement 6-digit OTP issued to ${user.email}`
      : `6-digit login OTP issued to ${user.email}`,
    outcome: "SUCCESS",
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });

  return {
    email: user.email,
    expiresInSeconds: OTP_EXPIRY_MINUTES * 60,
    resendCooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
  };
}

export async function verifyAdminOtpAndCreateSession(params: {
  email: string;
  otp: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<{
  rawSessionToken: string;
  csrfToken: string;
  expiresAt: Date;
  admin: AuthenticatedAdmin;
}> {
  const { user, profile, role } = await verifyAdminEligibilityByEmail(
    params.email,
    {
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      recordRejectionAudit: true,
    }
  );
  const now = new Date();

  const [challenge] = await db
    .select()
    .from(adminOtpChallenges)
    .where(
      and(
        eq(adminOtpChallenges.userId, user.id),
        eq(adminOtpChallenges.email, user.email)
      )
    )
    .orderBy(desc(adminOtpChallenges.createdAt))
    .limit(1);

  if (!challenge) {
    throw new AdminAuthError(
      "OTP_NOT_FOUND",
      "No active OTP verification challenge found. Please request a new code.",
      400
    );
  }

  if (challenge.consumedAt) {
    await recordAdminAuditLog({
      adminUserId: user.id,
      adminEmail: user.email,
      action: "ADMIN_OTP_REPLAY_BLOCKED",
      entityType: "ADMIN_AUTH",
      entityId: challenge.id,
      summary: `Rejected replay attempt on consumed OTP challenge for ${user.email}`,
      outcome: "DENIED",
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });

    throw new AdminAuthError(
      "OTP_ALREADY_USED",
      "This verification code has already been used. Please request a new OTP.",
      400
    );
  }

  if (challenge.invalidatedAt) {
    throw new AdminAuthError(
      "OTP_INVALIDATED",
      "This verification code is no longer active. Please request a new OTP.",
      400
    );
  }

  if (challenge.expiresAt <= now) {
    await db
      .update(adminOtpChallenges)
      .set({ invalidatedAt: now })
      .where(
        and(
          eq(adminOtpChallenges.id, challenge.id),
          isNull(adminOtpChallenges.invalidatedAt)
        )
      );

    await recordAdminAuditLog({
      adminUserId: user.id,
      adminEmail: user.email,
      action: "ADMIN_OTP_EXPIRED",
      entityType: "ADMIN_AUTH",
      entityId: challenge.id,
      summary: `Rejected expired OTP verification attempt for ${user.email}`,
      outcome: "FAILURE",
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });

    throw new AdminAuthError(
      "OTP_EXPIRED",
      "Your verification code has expired. Please request a new 6-digit OTP.",
      400
    );
  }

  if (challenge.attempts >= challenge.maxAttempts) {
    await db
      .update(adminOtpChallenges)
      .set({ invalidatedAt: now })
      .where(
        and(
          eq(adminOtpChallenges.id, challenge.id),
          isNull(adminOtpChallenges.invalidatedAt)
        )
      );

    throw new AdminAuthError(
      "OTP_MAX_ATTEMPTS_EXCEEDED",
      "Maximum verification attempts exceeded. Please request a new OTP code.",
      429
    );
  }

  const isMatch = verifyOtpHash(user.email, params.otp, challenge.otpHash);

  if (!isMatch) {
    // Concurrency-safe atomic attempt increment in PostgreSQL
    const [updatedChallenge] = await db
      .update(adminOtpChallenges)
      .set({
        attempts: sql`${adminOtpChallenges.attempts} + 1`,
        invalidatedAt: sql`CASE WHEN ${adminOtpChallenges.attempts} + 1 >= ${adminOtpChallenges.maxAttempts} THEN ${now.toISOString()}::timestamptz ELSE ${adminOtpChallenges.invalidatedAt} END`,
      })
      .where(
        and(
          eq(adminOtpChallenges.id, challenge.id),
          eq(adminOtpChallenges.userId, user.id),
          isNull(adminOtpChallenges.consumedAt),
          isNull(adminOtpChallenges.invalidatedAt)
        )
      )
      .returning({
        attempts: adminOtpChallenges.attempts,
        maxAttempts: adminOtpChallenges.maxAttempts,
      });

    const effectiveAttempts =
      updatedChallenge?.attempts ?? challenge.attempts + 1;
    const maxAttempts = updatedChallenge?.maxAttempts ?? challenge.maxAttempts;

    await recordAdminAuditLog({
      adminUserId: user.id,
      adminEmail: user.email,
      action: "ADMIN_OTP_FAILED",
      entityType: "ADMIN_AUTH",
      entityId: challenge.id,
      summary: `Failed OTP verification attempt (${effectiveAttempts}/${maxAttempts}) for ${user.email}`,
      outcome: "FAILURE",
      newState: {
        attempts: effectiveAttempts,
        maxAttempts,
      },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });

    const remaining = Math.max(0, maxAttempts - effectiveAttempts);
    if (remaining === 0) {
      throw new AdminAuthError(
        "OTP_MAX_ATTEMPTS_EXCEEDED",
        "Maximum verification attempts exceeded. Please request a new OTP code.",
        429
      );
    }

    throw new AdminAuthError(
      "OTP_INVALID",
      `Invalid verification code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
      401
    );
  }

  // Prevent concurrent same-process race on identical challenge ID
  if (inFlightChallengeVerifications.has(challenge.id)) {
    await recordAdminAuditLog({
      adminUserId: user.id,
      adminEmail: user.email,
      action: "ADMIN_OTP_REPLAY_BLOCKED",
      entityType: "ADMIN_AUTH",
      entityId: challenge.id,
      summary: `Blocked concurrent OTP verification race for ${user.email}`,
      outcome: "DENIED",
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });

    throw new AdminAuthError(
      "OTP_ALREADY_USED",
      "This verification code has already been used. Please request a new OTP.",
      400
    );
  }

  inFlightChallengeVerifications.add(challenge.id);
  try {
    // Atomic PostgreSQL conditional update: only one concurrent request can transition consumed_at from NULL
    const consumedRows = await db
      .update(adminOtpChallenges)
      .set({ consumedAt: now })
      .where(
        and(
          eq(adminOtpChallenges.id, challenge.id),
          eq(adminOtpChallenges.userId, user.id),
          eq(adminOtpChallenges.email, user.email),
          eq(adminOtpChallenges.otpHash, challenge.otpHash),
          isNull(adminOtpChallenges.consumedAt),
          isNull(adminOtpChallenges.invalidatedAt),
          gt(adminOtpChallenges.expiresAt, now),
          lt(adminOtpChallenges.attempts, challenge.maxAttempts)
        )
      )
      .returning({ id: adminOtpChallenges.id });

    if (consumedRows.length !== 1) {
      await recordAdminAuditLog({
        adminUserId: user.id,
        adminEmail: user.email,
        action: "ADMIN_OTP_REPLAY_BLOCKED",
        entityType: "ADMIN_AUTH",
        entityId: challenge.id,
        summary: `Rejected concurrent or replayed OTP consumption for ${user.email}`,
        outcome: "DENIED",
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      });

      throw new AdminAuthError(
        "OTP_ALREADY_USED",
        "This verification code has already been used. Please request a new OTP.",
        400
      );
    }

    // Update last login & OTP verification timestamps
    await db
      .update(users)
      .set({
        lastLoginAt: now,
        emailVerified: true,
        updatedAt: now,
      })
      .where(eq(users.id, user.id));

    await db
      .update(adminProfiles)
      .set({
        lastOtpVerifiedAt: now,
        updatedAt: now,
      })
      .where(eq(adminProfiles.id, profile.id));

    // Create server-side admin session hashed with ADMIN_SESSION_SECRET
    const rawSessionToken = generateSessionToken();
    const sessionTokenHash = hashSessionToken(rawSessionToken);
    const csrfToken = generateCsrfToken();
    const expiresAt = new Date(
      now.getTime() + ADMIN_SESSION_TTL_HOURS * 3_600_000
    );

    const [session] = await db
      .insert(adminSessions)
      .values({
        userId: user.id,
        sessionTokenHash,
        csrfToken,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
        expiresAt,
        lastActiveAt: now,
      })
      .returning();

    const effectivePermissions = resolveEffectiveAdminPermissions(
      role,
      profile.permissions
    );

    await recordAdminAuditLog({
      adminUserId: user.id,
      adminEmail: user.email,
      action: "ADMIN_LOGIN_SUCCESS",
      entityType: "ADMIN_SESSION",
      entityId: session.id,
      summary: `Administrator ${user.email} authenticated via email OTP`,
      outcome: "SUCCESS",
      newState: {
        sessionId: session.id,
        role,
        expiresAt: expiresAt.toISOString(),
      },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });

    const admin: AuthenticatedAdmin = {
      id: user.id,
      email: user.email,
      name: user.name,
      role,
      status: user.status,
      department: profile.department,
      title: profile.title,
      permissions: effectivePermissions,
      lastLoginAt: now.toISOString(),
      sessionId: session.id,
      csrfToken,
      sessionExpiresAt: expiresAt.toISOString(),
    };

    return {
      rawSessionToken,
      csrfToken,
      expiresAt,
      admin,
    };
  } finally {
    inFlightChallengeVerifications.delete(challenge.id);
  }
}

export async function validateAdminSessionToken(
  rawSessionToken?: string | null
): Promise<AuthenticatedAdmin | null> {
  if (!rawSessionToken || typeof rawSessionToken !== "string") {
    return null;
  }

  let tokenHash: string;
  try {
    tokenHash = hashSessionToken(rawSessionToken);
  } catch {
    return null;
  }

  const now = new Date();

  const [session] = await db
    .select()
    .from(adminSessions)
    .where(eq(adminSessions.sessionTokenHash, tokenHash))
    .limit(1);

  if (!session || session.revokedAt || session.expiresAt <= now) {
    return null;
  }

  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (!user) return null;

    // Recheck account status, role assignment, and approved admin_profiles record
    const { profile, role } = await verifyAdminEligibilityByEmail(user.email);

    await db
      .update(adminSessions)
      .set({ lastActiveAt: now })
      .where(eq(adminSessions.id, session.id));

    const effectivePermissions = resolveEffectiveAdminPermissions(
      role,
      profile.permissions
    );

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role,
      status: user.status,
      department: profile.department,
      title: profile.title,
      permissions: effectivePermissions,
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      sessionId: session.id,
      csrfToken: session.csrfToken,
      sessionExpiresAt: session.expiresAt.toISOString(),
    };
  } catch {
    return null;
  }
}

export async function revokeAdminSession(params: {
  rawSessionToken?: string | null;
  reason?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  if (!params.rawSessionToken) return;

  let tokenHash: string;
  try {
    tokenHash = hashSessionToken(params.rawSessionToken);
  } catch {
    return;
  }

  const now = new Date();

  const [session] = await db
    .select()
    .from(adminSessions)
    .where(eq(adminSessions.sessionTokenHash, tokenHash))
    .limit(1);

  if (!session || session.revokedAt) return;

  const revokedReason = params.reason || "ADMIN_LOGOUT";

  await db
    .update(adminSessions)
    .set({
      revokedAt: now,
      revokedReason,
    })
    .where(eq(adminSessions.id, session.id));

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (user) {
    await recordAdminAuditLog({
      adminUserId: user.id,
      adminEmail: user.email,
      action:
        revokedReason === "ADMIN_LOGOUT"
          ? "ADMIN_LOGOUT"
          : "ADMIN_SESSION_REVOKED",
      entityType: "ADMIN_SESSION",
      entityId: session.id,
      summary: `Administrator ${user.email} session revoked (${revokedReason})`,
      outcome: "SUCCESS",
      newState: {
        sessionId: session.id,
        revokedReason,
      },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }
}
