import { ZodError } from "zod";
import type { AuthenticatedAdmin } from "@/lib/admin/types";
import {
  addIncidentNoteSchema,
  approveVerificationSchema,
  rejectVerificationSchema,
  requestDocumentsSchema,
  requestOtpSchema,
  resendOtpSchema,
  updateBookingStatusSchema,
  updateCenterStatusSchema,
  updateIncidentStatusSchema,
  updatePlatformSettingsSchema,
  updateUserStatusSchema,
  verifyOtpSchema,
} from "@/lib/admin/validation";
import { checkRateLimit } from "./middleware/rate-limit";
import {
  ADMIN_CSRF_COOKIE_NAME,
  ADMIN_CSRF_HEADER_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_TTL_HOURS,
  verifyCsrfToken,
} from "./security/crypto";
import {
  AdminAuthError,
  issueAdminOtpChallenge,
  revokeAdminSession,
  validateAdminSessionToken,
  verifyAdminOtpAndCreateSession,
} from "./services/admin-auth.service";
import {
  getAdminDashboardActivity,
  getAdminDashboardAnalytics,
  getAdminDashboardStats,
} from "./services/dashboard.service";
import {
  addAdminIncidentNote,
  approveProviderVerification,
  getAdminBookingById,
  getAdminBookingHistory,
  getAdminCenterById,
  getAdminIncidentById,
  getAdminPlatformSettings,
  getAdminProviderById,
  getAdminReportsData,
  getAdminUserById,
  listAdminAuditLogs,
  listAdminBookings,
  listAdminCenters,
  listAdminIncidents,
  listAdminProviders,
  listAdminUsers,
  listAdminVerifications,
  rejectProviderVerification,
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
      sameSite: "lax",
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
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    },
  ];
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
    const headerCsrf =
      req.headers[ADMIN_CSRF_HEADER_NAME] ||
      req.headers[ADMIN_CSRF_HEADER_NAME.toUpperCase()];
    if (!headerCsrf || !verifyCsrfToken(headerCsrf, admin.csrfToken)) {
      throw new AdminAuthError(
        "CSRF_VALIDATION_FAILED",
        "Invalid or missing CSRF security token.",
        403
      );
    }
  }

  return admin;
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
      const ipLimit = checkRateLimit(
        `otp-req:ip:${req.ipAddress}`,
        10,
        10 * 60_000
      );
      const acctLimit = checkRateLimit(
        `otp-req:acct:${parsed.email}`,
        5,
        10 * 60_000
      );

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
      const acctLimit = checkRateLimit(
        `otp-resend:acct:${parsed.email}`,
        5,
        10 * 60_000
      );

      if (!acctLimit.allowed) {
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
      const ipLimit = checkRateLimit(
        `otp-verify:ip:${req.ipAddress}`,
        15,
        10 * 60_000
      );

      if (!ipLimit.allowed) {
        return {
          status: 429,
          body: {
            success: false,
            error: {
              code: "RATE_LIMIT_EXCEEDED",
              message:
                "Too many verification attempts from this IP. Please try again later.",
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
    // 2. Dashboard Endpoints
    // ==========================================

    if (routeKey === "GET /dashboard/stats") {
      const stats = await getAdminDashboardStats();
      return { status: 200, body: { success: true, data: stats } };
    }

    if (routeKey === "GET /dashboard/analytics") {
      const analytics = await getAdminDashboardAnalytics();
      return { status: 200, body: { success: true, data: analytics } };
    }

    if (routeKey === "GET /dashboard/activity") {
      const activity = await getAdminDashboardActivity();
      return { status: 200, body: { success: true, data: activity } };
    }

    // ==========================================
    // 3. User Management Endpoints
    // ==========================================

    if (routeKey === "GET /users") {
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
      const user = await getAdminUserById(req.segments[1]);
      return { status: 200, body: { success: true, data: user } };
    }

    if (
      method === "PATCH" &&
      req.segments[0] === "users" &&
      req.segments.length === 3 &&
      req.segments[2] === "status"
    ) {
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
    // 4. Provider & Verification Endpoints
    // ==========================================

    if (routeKey === "GET /providers") {
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
      const provider = await getAdminProviderById(req.segments[1]);
      return { status: 200, body: { success: true, data: provider } };
    }

    if (routeKey === "GET /verifications") {
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
    // 5. Daycare Centre Endpoints
    // ==========================================

    if (routeKey === "GET /centers") {
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
      const center = await getAdminCenterById(req.segments[1]);
      return { status: 200, body: { success: true, data: center } };
    }

    if (
      method === "PATCH" &&
      req.segments[0] === "centers" &&
      req.segments.length === 3 &&
      req.segments[2] === "status"
    ) {
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
    // 6. Booking Oversight Endpoints
    // ==========================================

    if (routeKey === "GET /bookings") {
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
      const booking = await getAdminBookingById(req.segments[1]);
      return { status: 200, body: { success: true, data: booking } };
    }

    if (
      method === "GET" &&
      req.segments[0] === "bookings" &&
      req.segments.length === 3 &&
      req.segments[2] === "history"
    ) {
      const history = await getAdminBookingHistory(req.segments[1]);
      return { status: 200, body: { success: true, data: history } };
    }

    if (
      method === "PATCH" &&
      req.segments[0] === "bookings" &&
      req.segments.length === 3 &&
      req.segments[2] === "status"
    ) {
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
    // 7. Safety Incidents Endpoints
    // ==========================================

    if (routeKey === "GET /incidents") {
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
      const incident = await getAdminIncidentById(req.segments[1]);
      return { status: 200, body: { success: true, data: incident } };
    }

    if (
      method === "PATCH" &&
      req.segments[0] === "incidents" &&
      req.segments.length === 3 &&
      req.segments[2] === "status"
    ) {
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
      const reports = await getAdminReportsData();
      return { status: 200, body: { success: true, data: reports } };
    }

    if (routeKey === "GET /audit-logs") {
      const logs = await listAdminAuditLogs({
        action: req.query.action,
        entityType: req.query.entityType,
        search: req.query.search,
        limit: req.query.limit ? Number(req.query.limit) : 100,
      });
      return { status: 200, body: { success: true, data: logs } };
    }

    if (routeKey === "GET /settings") {
      const settings = await getAdminPlatformSettings();
      return { status: 200, body: { success: true, data: settings } };
    }

    if (routeKey === "PATCH /settings") {
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
          message: `Admin API endpoint not found: ${routeKey}`,
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
            details: error.issues,
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

    console.error("[Admin API Error]", error);
    return {
      status: 500,
      body: {
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "An unexpected server error occurred.",
        },
      },
    };
  }
}
