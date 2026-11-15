import { ZodError } from "zod";
import type { AdminPermission, AuthenticatedAdmin } from "../lib/admin/types";
import {
  addIncidentNoteSchema,
  approveCaregiverVerificationSchema,
  approveCenterVerificationSchema,
  approveVerificationDocumentSchema,
  approveVerificationSchema,
  rejectCaregiverVerificationSchema,
  rejectCenterVerificationSchema,
  rejectVerificationDocumentSchema,
  rejectVerificationSchema,
  requestCenterDocumentsSchema,
  requestDocumentsSchema,
  requestOtpSchema,
  resendOtpSchema,
  updateBookingStatusSchema,
  updateCenterStatusSchema,
  updateIncidentStatusSchema,
  updatePlatformSettingsSchema,
  updateUserStatusSchema,
  verifyOtpSchema,
} from "../lib/admin/validation";
import { AdminMailDeliveryError } from "./mail/nodemailer";
import { checkRateLimit } from "./middleware/rate-limit";
import {
  ADMIN_CSRF_COOKIE_NAME,
  ADMIN_CSRF_HEADER_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_TTL_HOURS,
  AdminCryptoSecretError,
  verifyCsrfToken,
} from "./security/crypto";
import { hasAdminPermission } from "./security/permissions";
import {
  AdminAuthError,
  issueAdminOtpChallenge,
  revokeAdminSession,
  validateAdminSessionToken,
  verifyAdminOtpAndCreateSession,
} from "./services/admin-auth.service";
import { recordAdminAuditLog } from "./services/audit.service";
import {
  getAdminDashboardActivity,
  getAdminDashboardAnalytics,
  getAdminDashboardStats,
} from "./services/dashboard.service";
import {
  addAdminIncidentNote,
  approveCaregiverVerification,
  approveCenterVerification,
  approveProviderVerification,
  approveVerificationDocument,
  getAdminBookingById,
  getAdminBookingHistory,
  getAdminCaregiverVerificationById,
  getAdminCenterById,
  getAdminCenterVerificationById,
  getAdminIncidentById,
  getAdminPlatformSettings,
  getAdminProviderById,
  getAdminReportsData,
  getAdminUserById,
  getAdminVerificationDocumentById,
  listAdminAuditLogs,
  listAdminBookings,
  listAdminCaregiverVerifications,
  listAdminCenters,
  listAdminCenterVerifications,
  listAdminIncidents,
  listAdminProviders,
  listAdminUsers,
  listAdminVerificationDocuments,
  listAdminVerifications,
  rejectCaregiverVerification,
  rejectCenterVerification,
  rejectProviderVerification,
  rejectVerificationDocument,
  requestCenterDocuments,
  requestProviderDocuments,
  transitionAdminBookingStatus,
  updateAdminCenterStatus,
  updateAdminIncidentStatus,
  updateAdminPlatformSettings,
  updateAdminUserStatus,
} from "./services/operations.service";

export interface UnifiedApiRequest {
  method: string;
  segments: string[];
  query: Record<string, string | undefined>;
  body: unknown;
  cookies: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  ipAddress: string;
  userAgent: string;
}

export interface CookieInstruction {
  name: string;
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict";
  path: string;
  maxAge: number;
}

export interface UnifiedApiResponse {
  status: number;
  body: Record<string, unknown>;
  cookiesToSet?: CookieInstruction[];
  headers?: Record<string, string>;
}

function buildAuthCookies(
  rawSessionToken: string,
  csrfToken: string
): CookieInstruction[] {
  const isProd = process.env.NODE_ENV === "production";
  const maxAge = ADMIN_SESSION_TTL_HOURS * 3600;

  return [
    {
      name: ADMIN_SESSION_COOKIE_NAME,
      value: rawSessionToken,
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge,
    },
    {
      name: ADMIN_CSRF_COOKIE_NAME,
      value: csrfToken,
      httpOnly: false,
      secure: isProd,
      sameSite: "strict",
      path: "/",
      maxAge,
    },
  ];
}

function buildClearAuthCookies(): CookieInstruction[] {
  const isProd = process.env.NODE_ENV === "production";
  return [
    {
      name: ADMIN_SESSION_COOKIE_NAME,
      value: "",
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    },
    {
      name: ADMIN_CSRF_COOKIE_NAME,
      value: "",
      httpOnly: false,
      secure: isProd,
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    },
  ];
}

function validateMutatingRequestOrigin(req: UnifiedApiRequest): void {
  const originHeader = req.headers["origin"];
  const refererHeader = req.headers["referer"];
  const hostHeader = req.headers["x-forwarded-host"] || req.headers["host"];

  if (!originHeader && !refererHeader) {
    return;
  }

  const allowedHosts = new Set<string>();
  if (hostHeader) {
    allowedHosts.add(hostHeader.split(",")[0]!.trim().toLowerCase());
  }

  const configuredAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (configuredAppUrl) {
    try {
      allowedHosts.add(new URL(configuredAppUrl).host.toLowerCase());
    } catch {
      // Ignore malformed NEXT_PUBLIC_APP_URL
    }
  }

  if (allowedHosts.size === 0) {
    return;
  }

  const candidateUrl = originHeader || refererHeader;
  if (candidateUrl) {
    try {
      const parsedHost = new URL(candidateUrl).host.toLowerCase();
      if (!allowedHosts.has(parsedHost)) {
        throw new AdminAuthError(
          "CSRF_ORIGIN_MISMATCH",
          "Cross-origin administrative mutation request rejected.",
          403
        );
      }
    } catch (err) {
      if (err instanceof AdminAuthError) throw err;
      throw new AdminAuthError(
        "CSRF_ORIGIN_MISMATCH",
        "Invalid request origin header.",
        403
      );
    }
  }
}

async function requireAuthenticatedAdmin(
  req: UnifiedApiRequest,
  enforceCsrfForMutating = true
): Promise<AuthenticatedAdmin> {
  const rawToken = req.cookies[ADMIN_SESSION_COOKIE_NAME];
  const admin = await validateAdminSessionToken(rawToken);

  if (!admin) {
    throw new AdminAuthError(
      "UNAUTHORIZED_ADMIN_SESSION",
      "Authentication required. Please sign in to the Little Steps Admin Portal.",
      401
    );
  }

  const isMutating = ["POST", "PATCH", "PUT", "DELETE"].includes(
    req.method.toUpperCase()
  );

  if (enforceCsrfForMutating && isMutating) {
    validateMutatingRequestOrigin(req);

    const headerCsrf =
      req.headers[ADMIN_CSRF_HEADER_NAME] ||
      req.headers[ADMIN_CSRF_HEADER_NAME.toUpperCase()];
    const cookieCsrf = req.cookies[ADMIN_CSRF_COOKIE_NAME];

    const matchesSessionCsrf =
      Boolean(headerCsrf) && verifyCsrfToken(headerCsrf!, admin.csrfToken);
    const matchesCookieCsrf =
      !cookieCsrf || (Boolean(headerCsrf) && verifyCsrfToken(headerCsrf!, cookieCsrf));

    if (!matchesSessionCsrf || !matchesCookieCsrf) {
      await recordAdminAuditLog({
        adminUserId: admin.id,
        adminEmail: admin.email,
        action: "ADMIN_CSRF_VALIDATION_FAILED",
        entityType: "ADMIN_SESSION",
        entityId: admin.sessionId,
        summary: `Rejected mutating request (${req.method.toUpperCase()} /${req.segments.join("/")}) due to invalid or missing CSRF token`,
        outcome: "DENIED",
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });

      throw new AdminAuthError(
        "CSRF_VALIDATION_FAILED",
        "Invalid or missing CSRF security token.",
        403
      );
    }
  }

  return admin;
}

/**
 * Centralized server-side permission guard.
 * Kept strictly separate from session authentication (`requireAuthenticatedAdmin`).
 */
async function requireAdminPermission(
  admin: AuthenticatedAdmin,
  requiredPermission: AdminPermission,
  req: UnifiedApiRequest,
  routeKey: string
): Promise<void> {
  if (hasAdminPermission(admin, requiredPermission)) {
    return;
  }

  await recordAdminAuditLog({
    adminUserId: admin.id,
    adminEmail: admin.email,
    action: "UNAUTHORIZED_ADMIN_ACCESS_ATTEMPT",
    entityType: "ADMIN_PERMISSION",
    entityId: admin.id,
    summary: `Denied ${admin.email} (${admin.role}) access to ${routeKey}: missing required permission '${requiredPermission}'`,
    outcome: "DENIED",
    newState: {
      routeKey,
      requiredPermission,
      role: admin.role,
    },
    ipAddress: req.ipAddress,
    userAgent: req.userAgent,
  });

  throw new AdminAuthError(
    "INSUFFICIENT_ADMIN_PERMISSIONS",
    `Access denied. Required permission '${requiredPermission}' is not granted to your administrator profile.`,
    403
  );
}

function sanitizeErrorForServerLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const redactedMessage = error.message
      .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED_DB_URI]")
      .replace(/\b[0-9a-fA-F]{48,}\b/g, "[REDACTED_HEX_TOKEN]");
    return {
      name: error.name,
      message: redactedMessage,
    };
  }
  return { name: "UnknownError" };
}

export async function dispatchAdminApiRequest(
  req: UnifiedApiRequest
): Promise<UnifiedApiResponse> {
  const method = req.method.toUpperCase();
  const routeKey = `${method} /${req.segments.join("/")}`;

  try {
    // ==========================================
    // 1. Admin Auth Endpoints
    // ==========================================

    if (routeKey === "POST /auth/request-otp") {
      const parsed = requestOtpSchema.parse(req.body);
      const [ipLimit, acctLimit] = await Promise.all([
        checkRateLimit(`otp-req-ip:${req.ipAddress}`, 10, 10 * 60_000),
        checkRateLimit(`otp-req-acct:${parsed.email}`, 5, 10 * 60_000),
      ]);

      if (!ipLimit.allowed || !acctLimit.allowed) {
        return {
          status: 429,
          body: {
            success: false,
            error: {
              code: "RATE_LIMIT_EXCEEDED",
              message:
                "Too many OTP requests. Please wait before trying again.",
            },
          },
        };
      }

      const result = await issueAdminOtpChallenge({
        email: parsed.email,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
        isResend: false,
      });

      return {
        status: 200,
        body: {
          success: true,
          message:
            "A 6-digit verification code has been sent to your registered admin email.",
          data: result,
        },
      };
    }

    if (routeKey === "POST /auth/resend-otp") {
      const parsed = resendOtpSchema.parse(req.body);
      const [ipLimit, acctLimit] = await Promise.all([
        checkRateLimit(`otp-resend-ip:${req.ipAddress}`, 10, 10 * 60_000),
        checkRateLimit(`otp-resend-acct:${parsed.email}`, 5, 10 * 60_000),
      ]);

      if (!ipLimit.allowed || !acctLimit.allowed) {
        return {
          status: 429,
          body: {
            success: false,
            error: {
              code: "RATE_LIMIT_EXCEEDED",
              message:
                "Too many OTP resend attempts. Please wait a few minutes.",
            },
          },
        };
      }

      const result = await issueAdminOtpChallenge({
        email: parsed.email,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
        isResend: true,
      });

      return {
        status: 200,
        body: {
          success: true,
          message:
            "A new 6-digit verification code has been sent to your admin email.",
          data: result,
        },
      };
    }

    if (routeKey === "POST /auth/verify-otp") {
      const parsed = verifyOtpSchema.parse(req.body);
      const [ipLimit, acctLimit] = await Promise.all([
        checkRateLimit(`otp-verify-ip:${req.ipAddress}`, 15, 10 * 60_000),
        checkRateLimit(`otp-verify-acct:${parsed.email}`, 10, 10 * 60_000),
      ]);

      if (!ipLimit.allowed || !acctLimit.allowed) {
        return {
          status: 429,
          body: {
            success: false,
            error: {
              code: "RATE_LIMIT_EXCEEDED",
              message:
                "Too many verification attempts. Please try again later.",
            },
          },
        };
      }

      const sessionResult = await verifyAdminOtpAndCreateSession({
        email: parsed.email,
        otp: parsed.otp,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });

      return {
        status: 200,
        cookiesToSet: buildAuthCookies(
          sessionResult.rawSessionToken,
          sessionResult.csrfToken
        ),
        body: {
          success: true,
          message: "Admin authentication successful.",
          data: {
            admin: sessionResult.admin,
          },
        },
      };
    }

    if (routeKey === "POST /auth/logout") {
      const rawToken = req.cookies[ADMIN_SESSION_COOKIE_NAME];
      await revokeAdminSession({
        rawSessionToken: rawToken,
        reason: "ADMIN_LOGOUT",
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });

      return {
        status: 200,
        cookiesToSet: buildClearAuthCookies(),
        body: {
          success: true,
          message: "Admin session terminated.",
          data: { loggedOut: true },
        },
      };
    }

    if (routeKey === "GET /auth/me") {
      const admin = await requireAuthenticatedAdmin(req, false);
      return {
        status: 200,
        body: {
          success: true,
          data: { admin },
        },
      };
    }

    // All subsequent endpoints require a valid authenticated administrator session (+ CSRF for mutations)
    const admin = await requireAuthenticatedAdmin(req, true);

    // ==========================================
    // 2. Dashboard Endpoints (`dashboard:read`)
    // ==========================================

    if (routeKey === "GET /dashboard/stats") {
      await requireAdminPermission(admin, "dashboard:read", req, routeKey);
      const stats = await getAdminDashboardStats();
      return { status: 200, body: { success: true, data: stats } };
    }

    if (routeKey === "GET /dashboard/analytics") {
      await requireAdminPermission(admin, "dashboard:read", req, routeKey);
      const analytics = await getAdminDashboardAnalytics();
      return { status: 200, body: { success: true, data: analytics } };
    }

    if (routeKey === "GET /dashboard/activity") {
      await requireAdminPermission(admin, "dashboard:read", req, routeKey);
      const activity = await getAdminDashboardActivity();
      return { status: 200, body: { success: true, data: activity } };
    }

    // ==========================================
    // 3. User Management Endpoints (`users:read` / `users:manage`)
    // ==========================================

    if (routeKey === "GET /users") {
      await requireAdminPermission(admin, "users:read", req, routeKey);
      const result = await listAdminUsers({
        search: req.query.search,
        role: req.query.role,
        status: req.query.status,
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 25,
      });
      return {
        status: 200,
        body: {
          success: true,
          data: result.items,
          meta: result.meta,
        },
      };
    }

    if (
      method === "GET" &&
      req.segments[0] === "users" &&
      req.segments.length === 2
    ) {
      await requireAdminPermission(admin, "users:read", req, routeKey);
      const user = await getAdminUserById(req.segments[1]);
      return { status: 200, body: { success: true, data: user } };
    }

    if (
      method === "PATCH" &&
      req.segments[0] === "users" &&
      req.segments.length === 3 &&
      req.segments[2] === "status"
    ) {
      await requireAdminPermission(admin, "users:manage", req, routeKey);
      const parsed = updateUserStatusSchema.parse(req.body);
      const updated = await updateAdminUserStatus({
        userId: req.segments[1],
        status: parsed.status,
        reason: parsed.reason,
        admin,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });
      return {
        status: 200,
        body: {
          success: true,
          message: `Account status updated to ${parsed.status}.`,
          data: updated,
        },
      };
    }

    // ==========================================
    // 4. Provider & Verification Endpoints (`providers:read` / `providers:verify`)
    // ==========================================

    if (routeKey === "GET /providers") {
      await requireAdminPermission(admin, "providers:read", req, routeKey);
      const items = await listAdminProviders({
        search: req.query.search,
        verificationStatus: req.query.status,
      });
      return { status: 200, body: { success: true, data: items } };
    }

    if (
      method === "GET" &&
      req.segments[0] === "providers" &&
      req.segments.length === 2
    ) {
      await requireAdminPermission(admin, "providers:read", req, routeKey);
      const provider = await getAdminProviderById(req.segments[1]);
      return { status: 200, body: { success: true, data: provider } };
    }

    if (routeKey === "GET /verifications") {
      await requireAdminPermission(admin, "providers:read", req, routeKey);
      const items = await listAdminVerifications({
        status: req.query.status,
        search: req.query.search,
      });
      return { status: 200, body: { success: true, data: items } };
    }

    if (
      method === "POST" &&
      req.segments[0] === "verifications" &&
      req.segments.length === 3 &&
      req.segments[2] === "approve"
    ) {
      await requireAdminPermission(admin, "providers:verify", req, routeKey);
      const parsed = approveVerificationSchema.parse(req.body);
      const result = await approveProviderVerification({
        verificationId: req.segments[1],
        reviewComments: parsed.reviewComments,
        checklistState: parsed.checklistState,
        admin,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });
      return {
        status: 200,
        body: {
          success: true,
          message: "Provider verification approved.",
          data: result,
        },
      };
    }

    if (
      method === "POST" &&
      req.segments[0] === "verifications" &&
      req.segments.length === 3 &&
      req.segments[2] === "reject"
    ) {
      await requireAdminPermission(admin, "providers:verify", req, routeKey);
      const parsed = rejectVerificationSchema.parse(req.body);
      const result = await rejectProviderVerification({
        verificationId: req.segments[1],
        rejectionReason: parsed.rejectionReason,
        reviewComments: parsed.reviewComments,
        suspendProvider: parsed.suspendProvider,
        admin,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });
      return {
        status: 200,
        body: {
          success: true,
          message: parsed.suspendProvider
            ? "Provider verification suspended."
            : "Provider verification rejected.",
          data: result,
        },
      };
    }

    if (
      method === "POST" &&
      req.segments[0] === "verifications" &&
      req.segments.length === 3 &&
      req.segments[2] === "request-documents"
    ) {
      await requireAdminPermission(admin, "providers:verify", req, routeKey);
      const parsed = requestDocumentsSchema.parse(req.body);
      const result = await requestProviderDocuments({
        verificationId: req.segments[1],
        requestedDocuments: parsed.requestedDocuments,
        reviewComments: parsed.reviewComments,
        admin,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });
      return {
        status: 200,
        body: {
          success: true,
          message: "Additional verification documents requested.",
          data: result,
        },
      };
    }

    // ==========================================
    // 4b. Centre Verification Endpoints (`providers:read` / `providers:verify`)
    // ==========================================

    if (routeKey === "GET /center-verifications") {
      await requireAdminPermission(admin, "providers:read", req, routeKey);
      const items = await listAdminCenterVerifications({
        status: req.query.status,
        search: req.query.search,
      });
      return { status: 200, body: { success: true, data: items } };
    }

    if (
      method === "GET" &&
      req.segments[0] === "center-verifications" &&
      req.segments.length === 2
    ) {
      await requireAdminPermission(admin, "providers:read", req, routeKey);
      const item = await getAdminCenterVerificationById(req.segments[1]);
      return { status: 200, body: { success: true, data: item } };
    }

    if (
      method === "POST" &&
      req.segments[0] === "center-verifications" &&
      req.segments.length === 3 &&
      req.segments[2] === "approve"
    ) {
      await requireAdminPermission(admin, "providers:verify", req, routeKey);
      const parsed = approveCenterVerificationSchema.parse(req.body);
      const result = await approveCenterVerification({
        idOrCenterId: req.segments[1],
        reviewComments: parsed.reviewComments,
        checklistState: parsed.checklistState,
        safetyComplianceNotes: parsed.safetyComplianceNotes,
        activateListing: parsed.activateListing,
        admin,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });
      return {
        status: 200,
        body: {
          success: true,
          message: "Daycare centre verification approved and listing activated.",
          data: result,
        },
      };
    }

    if (
      method === "POST" &&
      req.segments[0] === "center-verifications" &&
      req.segments.length === 3 &&
      req.segments[2] === "reject"
    ) {
      await requireAdminPermission(admin, "providers:verify", req, routeKey);
      const parsed = rejectCenterVerificationSchema.parse(req.body);
      const result = await rejectCenterVerification({
        idOrCenterId: req.segments[1],
        rejectionReason: parsed.rejectionReason,
        reviewComments: parsed.reviewComments,
        suspendCenter: parsed.suspendCenter,
        admin,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });
      return {
        status: 200,
        body: {
          success: true,
          message: parsed.suspendCenter
            ? "Daycare centre verification suspended."
            : "Daycare centre verification rejected.",
          data: result,
        },
      };
    }

    if (
      method === "POST" &&
      req.segments[0] === "center-verifications" &&
      req.segments.length === 3 &&
      req.segments[2] === "request-documents"
    ) {
      await requireAdminPermission(admin, "providers:verify", req, routeKey);
      const parsed = requestCenterDocumentsSchema.parse(req.body);
      const result = await requestCenterDocuments({
        idOrCenterId: req.segments[1],
        requestedDocuments: parsed.requestedDocuments,
        reviewComments: parsed.reviewComments,
        admin,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });
      return {
        status: 200,
        body: {
          success: true,
          message: "Additional daycare centre verification documents requested.",
          data: result,
        },
      };
    }

    // ==========================================
    // 4c. Caregiver Verification Endpoints (`providers:read` / `providers:verify`)
    // ==========================================

    if (routeKey === "GET /caregiver-verifications") {
      await requireAdminPermission(admin, "providers:read", req, routeKey);
      const items = await listAdminCaregiverVerifications({
        status: req.query.status,
        search: req.query.search,
        centerId: req.query.centerId,
      });
      return { status: 200, body: { success: true, data: items } };
    }

    if (
      method === "GET" &&
      req.segments[0] === "caregiver-verifications" &&
      req.segments.length === 2
    ) {
      await requireAdminPermission(admin, "providers:read", req, routeKey);
      const item = await getAdminCaregiverVerificationById(req.segments[1]);
      return { status: 200, body: { success: true, data: item } };
    }

    if (
      method === "POST" &&
      req.segments[0] === "caregiver-verifications" &&
      req.segments.length === 3 &&
      req.segments[2] === "approve"
    ) {
      await requireAdminPermission(admin, "providers:verify", req, routeKey);
      const parsed = approveCaregiverVerificationSchema.parse(req.body);
      const result = await approveCaregiverVerification({
        idOrCaregiverId: req.segments[1],
        reviewComments: parsed.reviewComments,
        expiresAt: parsed.expiresAt,
        checklistState: parsed.checklistState,
        admin,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });
      return {
        status: 200,
        body: {
          success: true,
          message: "Caregiver verification approved.",
          data: result,
        },
      };
    }

    if (
      method === "POST" &&
      req.segments[0] === "caregiver-verifications" &&
      req.segments.length === 3 &&
      req.segments[2] === "reject"
    ) {
      await requireAdminPermission(admin, "providers:verify", req, routeKey);
      const parsed = rejectCaregiverVerificationSchema.parse(req.body);
      const result = await rejectCaregiverVerification({
        idOrCaregiverId: req.segments[1],
        rejectionReason: parsed.rejectionReason,
        reviewComments: parsed.reviewComments,
        suspendCaregiver: parsed.suspendCaregiver,
        admin,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });
      return {
        status: 200,
        body: {
          success: true,
          message: parsed.suspendCaregiver
            ? "Caregiver verification suspended."
            : "Caregiver verification rejected.",
          data: result,
        },
      };
    }

    // ==========================================
    // 4d. Verification Document Endpoints (`providers:read` / `providers:verify`)
    // ==========================================

    if (routeKey === "GET /verification-documents") {
      await requireAdminPermission(admin, "providers:read", req, routeKey);
      const items = await listAdminVerificationDocuments({
        status: req.query.status,
        providerId: req.query.providerId,
        centerId: req.query.centerId,
        caregiverId: req.query.caregiverId,
        search: req.query.search,
      });
      return { status: 200, body: { success: true, data: items } };
    }

    if (
      method === "GET" &&
      req.segments[0] === "verification-documents" &&
      req.segments.length === 2
    ) {
      await requireAdminPermission(admin, "providers:read", req, routeKey);
      const item = await getAdminVerificationDocumentById(req.segments[1]);
      return { status: 200, body: { success: true, data: item } };
    }

    if (
      method === "POST" &&
      req.segments[0] === "verification-documents" &&
      req.segments.length === 3 &&
      req.segments[2] === "approve"
    ) {
      await requireAdminPermission(admin, "providers:verify", req, routeKey);
      const parsed = approveVerificationDocumentSchema.parse(req.body ?? {});
      const result = await approveVerificationDocument({
        documentId: req.segments[1],
        reviewNotes:
          parsed.reviewNotes ||
          parsed.reviewComments ||
          "Verified document authenticity and compliance.",
        expiresAt: parsed.expiresAt,
        admin,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });
      return {
        status: 200,
        body: {
          success: true,
          message: "Verification document approved.",
          data: result,
        },
      };
    }

    if (
      method === "POST" &&
      req.segments[0] === "verification-documents" &&
      req.segments.length === 3 &&
      req.segments[2] === "reject"
    ) {
      await requireAdminPermission(admin, "providers:verify", req, routeKey);
      const parsed = rejectVerificationDocumentSchema.parse(req.body);
      const result = await rejectVerificationDocument({
        documentId: req.segments[1],
        rejectionReason: parsed.rejectionReason,
        reviewNotes: parsed.reviewNotes || parsed.reviewComments,
        requestReplacement:
          parsed.requestReplacement ?? parsed.replacementRequested,
        admin,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });
      return {
        status: 200,
        body: {
          success: true,
          message: "Verification document rejected.",
          data: result,
        },
      };
    }

    // ==========================================
    // 5. Daycare Centre Endpoints (`providers:read` / `centers:manage`)
    // ==========================================

    if (routeKey === "GET /centers") {
      await requireAdminPermission(admin, "providers:read", req, routeKey);
      const items = await listAdminCenters({
        search: req.query.search,
        listingStatus: req.query.listingStatus,
        verificationStatus: req.query.verificationStatus,
        city: req.query.city,
      });
      return { status: 200, body: { success: true, data: items } };
    }

    if (
      method === "GET" &&
      req.segments[0] === "centers" &&
      req.segments.length === 2
    ) {
      await requireAdminPermission(admin, "providers:read", req, routeKey);
      const center = await getAdminCenterById(req.segments[1]);
      return { status: 200, body: { success: true, data: center } };
    }

    if (
      method === "PATCH" &&
      req.segments[0] === "centers" &&
      req.segments.length === 3 &&
      req.segments[2] === "status"
    ) {
      await requireAdminPermission(admin, "centers:manage", req, routeKey);
      const parsed = updateCenterStatusSchema.parse(req.body);
      const updated = await updateAdminCenterStatus({
        centerId: req.segments[1],
        listingStatus: parsed.listingStatus,
        reason: parsed.reason,
        admin,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });
      return {
        status: 200,
        body: {
          success: true,
          message: `Centre listing status updated to ${parsed.listingStatus}.`,
          data: updated,
        },
      };
    }

    // ==========================================
    // 6. Booking Oversight Endpoints (`bookings:read` / `bookings:manage`)
    // ==========================================

    if (routeKey === "GET /bookings") {
      await requireAdminPermission(admin, "bookings:read", req, routeKey);
      const items = await listAdminBookings({
        search: req.query.search,
        status: req.query.status,
        centerId: req.query.centerId,
        providerId: req.query.providerId,
      });
      return { status: 200, body: { success: true, data: items } };
    }

    if (
      method === "GET" &&
      req.segments[0] === "bookings" &&
      req.segments.length === 2
    ) {
      await requireAdminPermission(admin, "bookings:read", req, routeKey);
      const booking = await getAdminBookingById(req.segments[1]);
      return { status: 200, body: { success: true, data: booking } };
    }

    if (
      method === "GET" &&
      req.segments[0] === "bookings" &&
      req.segments.length === 3 &&
      req.segments[2] === "history"
    ) {
      await requireAdminPermission(admin, "bookings:read", req, routeKey);
      const history = await getAdminBookingHistory(req.segments[1]);
      return { status: 200, body: { success: true, data: history } };
    }

    if (
      method === "PATCH" &&
      req.segments[0] === "bookings" &&
      req.segments.length === 3 &&
      req.segments[2] === "status"
    ) {
      await requireAdminPermission(admin, "bookings:manage", req, routeKey);
      const parsed = updateBookingStatusSchema.parse(req.body);
      const updated = await transitionAdminBookingStatus({
        bookingId: req.segments[1],
        toStatus: parsed.status,
        reason: parsed.reason,
        admin,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });
      return {
        status: 200,
        body: {
          success: true,
          message: `Booking transitioned to ${parsed.status}.`,
          data: updated,
        },
      };
    }

    // ==========================================
    // 7. Safety Incidents Endpoints (`incidents:read` / `incidents:manage`)
    // ==========================================

    if (routeKey === "GET /incidents") {
      await requireAdminPermission(admin, "incidents:read", req, routeKey);
      const items = await listAdminIncidents({
        status: req.query.status,
        severity: req.query.severity,
        category: req.query.category,
        search: req.query.search,
      });
      return { status: 200, body: { success: true, data: items } };
    }

    if (
      method === "GET" &&
      req.segments[0] === "incidents" &&
      req.segments.length === 2
    ) {
      await requireAdminPermission(admin, "incidents:read", req, routeKey);
      const incident = await getAdminIncidentById(req.segments[1]);
      return { status: 200, body: { success: true, data: incident } };
    }

    if (
      method === "PATCH" &&
      req.segments[0] === "incidents" &&
      req.segments.length === 3 &&
      req.segments[2] === "status"
    ) {
      await requireAdminPermission(admin, "incidents:manage", req, routeKey);
      const parsed = updateIncidentStatusSchema.parse(req.body);
      const updated = await updateAdminIncidentStatus({
        incidentId: req.segments[1],
        status: parsed.status,
        assignedAdminId: parsed.assignedAdminId,
        resolutionOutcome: parsed.resolutionOutcome,
        note: parsed.note,
        admin,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });
      return {
        status: 200,
        body: {
          success: true,
          message: `Incident status updated to ${parsed.status}.`,
          data: updated,
        },
      };
    }

    if (
      method === "POST" &&
      req.segments[0] === "incidents" &&
      req.segments.length === 3 &&
      req.segments[2] === "notes"
    ) {
      await requireAdminPermission(admin, "incidents:manage", req, routeKey);
      const parsed = addIncidentNoteSchema.parse(req.body);
      const updated = await addAdminIncidentNote({
        incidentId: req.segments[1],
        note: parsed.note,
        assignedAdminId: parsed.assignedAdminId,
        admin,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });
      return {
        status: 200,
        body: {
          success: true,
          message: "Investigation note recorded.",
          data: updated,
        },
      };
    }

    // ==========================================
    // 8. Reports, Audit Logs & Settings Endpoints
    // ==========================================

    if (routeKey === "GET /reports") {
      await requireAdminPermission(admin, "reports:read", req, routeKey);
      const reports = await getAdminReportsData();
      return { status: 200, body: { success: true, data: reports } };
    }

    if (routeKey === "GET /audit-logs") {
      await requireAdminPermission(admin, "audit:read", req, routeKey);
      const logs = await listAdminAuditLogs({
        action: req.query.action,
        entityType: req.query.entityType,
        search: req.query.search,
        limit: req.query.limit ? Number(req.query.limit) : 100,
      });
      return { status: 200, body: { success: true, data: logs } };
    }

    if (routeKey === "GET /settings") {
      await requireAdminPermission(admin, "settings:manage", req, routeKey);
      const settings = await getAdminPlatformSettings();
      return { status: 200, body: { success: true, data: settings } };
    }

    if (routeKey === "PATCH /settings") {
      await requireAdminPermission(admin, "settings:manage", req, routeKey);
      const parsed = updatePlatformSettingsSchema.parse(req.body);
      const updated = await updateAdminPlatformSettings({
        settings: parsed.settings,
        admin,
        ipAddress: req.ipAddress,
        userAgent: req.userAgent,
      });
      return {
        status: 200,
        body: {
          success: true,
          message: "Platform settings saved.",
          data: updated,
        },
      };
    }

    return {
      status: 404,
      body: {
        success: false,
        error: {
          code: "ENDPOINT_NOT_FOUND",
          message: "Requested administrative API endpoint does not exist.",
        },
      },
    };
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      return {
        status: 400,
        body: {
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: firstIssue?.message || "Invalid request payload.",
            details: error.issues.map((i) => ({
              path: i.path,
              message: i.message,
            })),
          },
        },
      };
    }

    if (error instanceof AdminAuthError) {
      return {
        status: error.statusCode,
        body: {
          success: false,
          error: {
            code: error.code,
            message: error.message,
          },
        },
      };
    }

    if (error instanceof AdminMailDeliveryError) {
      return {
        status: error.statusCode,
        body: {
          success: false,
          error: {
            code: error.code,
            message: error.message,
          },
        },
      };
    }

    if (error instanceof AdminCryptoSecretError) {
      console.error(
        "[Admin Security Config Error]",
        sanitizeErrorForServerLog(error)
      );
      return {
        status: 500,
        body: {
          success: false,
          error: {
            code: "SERVER_SECURITY_CONFIGURATION_ERROR",
            message:
              "Administrative authentication service is temporarily unavailable.",
          },
        },
      };
    }

    console.error("[Admin API Error]", sanitizeErrorForServerLog(error));
    return {
      status: 500,
      body: {
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected server error occurred. Please try again later.",
        },
      },
    };
  }
}
