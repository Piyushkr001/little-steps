import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/config/db";
import {
  adminOtpChallenges,
  adminProfiles,
  adminSessions,
  userRoles,
  users,
} from "@/config/schema";
import type { AdminRole, AuthenticatedAdmin } from "@/lib/admin/types";
import { hasAdminEmailKeyword } from "@/lib/admin/validation";
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
import { recordAdminAuditLog } from "./audit.service";
import { ensureAdminPortalSeeded } from "./seed.service";

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

/**
 * Strictly validates all 4 pre-OTP Admin Email Eligibility requirements:
 * 1. Email contains keyword `admin` (case-insensitive).
 * 2. Email belongs to an existing, explicitly authorized administrator account (`admin_profiles.is_approved = true`).
 * 3. Account has an active `ADMIN` or `SUPER_ADMIN` role.
 * 4. Account has not been suspended or disabled (`status === "ACTIVE"`).
 */
export async function verifyAdminEligibilityByEmail(
  rawEmail: string
): Promise<EligibleAdminRecord> {
  await ensureAdminPortalSeeded();

  const email = rawEmail.trim().toLowerCase();

  // Requirement 1: Keyword rule
  if (!hasAdminEmailKeyword(email)) {
    throw new AdminAuthError(
      "ADMIN_ELIGIBILITY_FAILED",
      "Access denied. This email address is not authorized for the Little Steps Admin Portal.",
      403
    );
  }

  const [userRecord] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // Requirement 2: Existing account check (use uniform message to avoid enumeration leaks)
  if (!userRecord) {
    throw new AdminAuthError(
      "ADMIN_ELIGIBILITY_FAILED",
      "Access denied. This email address is not authorized for the Little Steps Admin Portal.",
      403
    );
  }

  // Requirement 4: Not suspended or disabled
  if (userRecord.status !== "ACTIVE") {
    throw new AdminAuthError(
      "ADMIN_ACCOUNT_INACTIVE",
      "Access denied. This administrator account is currently suspended or disabled.",
      403
    );
  }

  // Requirement 3: Active ADMIN or SUPER_ADMIN role
  if (userRecord.role !== "ADMIN" && userRecord.role !== "SUPER_ADMIN") {
    throw new AdminAuthError(
      "ADMIN_ROLE_REQUIRED",
      "Access denied. Only authorized ADMIN and SUPER_ADMIN accounts may access the Admin Portal.",
      403
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
    throw new AdminAuthError(
      "ADMIN_ROLE_REQUIRED",
      "Access denied. Active administrator role assignment is required.",
      403
    );
  }

  // Requirement 2b: Explicit approved admin_profiles entry
  const [profileRecord] = await db
    .select()
    .from(adminProfiles)
    .where(eq(adminProfiles.userId, userRecord.id))
    .limit(1);

  if (!profileRecord || !profileRecord.isApproved) {
    throw new AdminAuthError(
      "ADMIN_PROFILE_UNAPPROVED",
      "Access denied. This account has not been provisioned for Admin Portal access.",
      403
    );
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
  const { user } = await verifyAdminEligibilityByEmail(params.email);
  const now = new Date();

  // Check if the most recent active challenge is still within the 60s resend cooldown window
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

  // Invalidate any previous unconsumed OTP challenges for this administrator
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

  const DEMO_ADMIN_EMAILS = new Set([
    "admin@littlesteps.com",
    "superadmin@littlesteps.com",
    "littlesteps.admin@gmail.com",
  ]);
  const rawOtp =
    process.env.NODE_ENV !== "production" && DEMO_ADMIN_EMAILS.has(user.email)
      ? "123456"
      : generateNumericOtp();
  const otpHash = hashOtp(user.email, rawOtp);
  const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MINUTES * 60_000);
  const resendAvailableAt = new Date(
    now.getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1_000
  );

  await db.insert(adminOtpChallenges).values({
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
  });

  await sendAdminOtpEmail({
    toEmail: user.email,
    adminName: user.name,
    otpCode: rawOtp,
    ipAddress: params.ipAddress,
  });

  await recordAdminAuditLog({
    adminUserId: user.id,
    adminEmail: user.email,
    action: params.isResend ? "ADMIN_OTP_RESENT" : "ADMIN_OTP_REQUESTED",
    entityType: "ADMIN_AUTH",
    entityId: user.id,
    summary: params.isResend
      ? `Replacement 6-digit OTP issued to ${user.email}`
      : `6-digit login OTP issued to ${user.email}`,
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
    params.email
  );
  const now = new Date();

  const [challenge] = await db
    .select()
    .from(adminOtpChallenges)
    .where(eq(adminOtpChallenges.userId, user.id))
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
      .where(eq(adminOtpChallenges.id, challenge.id));

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
      .where(eq(adminOtpChallenges.id, challenge.id));

    throw new AdminAuthError(
      "OTP_MAX_ATTEMPTS_EXCEEDED",
      "Maximum verification attempts exceeded. Please request a new OTP code.",
      429
    );
  }

  const isMatch = verifyOtpHash(user.email, params.otp, challenge.otpHash);

  if (!isMatch) {
    const nextAttempts = challenge.attempts + 1;
    const lockNow = nextAttempts >= challenge.maxAttempts ? now : null;

    await db
      .update(adminOtpChallenges)
      .set({
        attempts: nextAttempts,
        ...(lockNow ? { invalidatedAt: lockNow } : {}),
      })
      .where(eq(adminOtpChallenges.id, challenge.id));

    await recordAdminAuditLog({
      adminUserId: user.id,
      adminEmail: user.email,
      action: "ADMIN_OTP_FAILED",
      entityType: "ADMIN_AUTH",
      entityId: user.id,
      summary: `Failed OTP verification attempt (${nextAttempts}/${challenge.maxAttempts}) for ${user.email}`,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });

    const remaining = Math.max(0, challenge.maxAttempts - nextAttempts);
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

  // Mark challenge as consumed to prevent OTP replay
  await db
    .update(adminOtpChallenges)
    .set({ consumedAt: now })
    .where(eq(adminOtpChallenges.id, challenge.id));

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

  // Create server-side admin session
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

  await recordAdminAuditLog({
    adminUserId: user.id,
    adminEmail: user.email,
    action: "ADMIN_LOGIN_SUCCESS",
    entityType: "ADMIN_SESSION",
    entityId: session.id,
    summary: `Administrator ${user.email} authenticated via email OTP`,
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
    permissions: profile.permissions ?? [],
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
}

export async function validateAdminSessionToken(
  rawSessionToken?: string | null
): Promise<AuthenticatedAdmin | null> {
  if (!rawSessionToken || typeof rawSessionToken !== "string") {
    return null;
  }

  await ensureAdminPortalSeeded();

  const tokenHash = hashSessionToken(rawSessionToken);
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

    const { profile, role } = await verifyAdminEligibilityByEmail(user.email);

    await db
      .update(adminSessions)
      .set({ lastActiveAt: now })
      .where(eq(adminSessions.id, session.id));

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role,
      status: user.status,
      department: profile.department,
      title: profile.title,
      permissions: profile.permissions ?? [],
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
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  if (!params.rawSessionToken) return;

  const tokenHash = hashSessionToken(params.rawSessionToken);
  const now = new Date();

  const [session] = await db
    .select()
    .from(adminSessions)
    .where(eq(adminSessions.sessionTokenHash, tokenHash))
    .limit(1);

  if (!session || session.revokedAt) return;

  await db
    .update(adminSessions)
    .set({
      revokedAt: now,
      revokedReason: "ADMIN_LOGOUT",
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
      action: "ADMIN_LOGOUT",
      entityType: "ADMIN_SESSION",
      entityId: session.id,
      summary: `Administrator ${user.email} signed out and invalidated session`,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }
}
