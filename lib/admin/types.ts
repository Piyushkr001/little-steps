export type AdminRole = "ADMIN" | "SUPER_ADMIN";
export type UserRole = "PARENT" | "PROVIDER" | "CAREGIVER" | "ADMIN" | "SUPER_ADMIN";
export type AccountStatus = "ACTIVE" | "SUSPENDED" | "DISABLED" | "PENDING";

export type AdminPermission =
  | "dashboard:read"
  | "users:read"
  | "users:manage"
  | "providers:read"
  | "providers:verify"
  | "centers:manage"
  | "bookings:read"
  | "bookings:manage"
  | "incidents:read"
  | "incidents:manage"
  | "reports:read"
  | "audit:read"
  | "settings:manage";

export type VerificationStatus =
  | "NOT_SUBMITTED"
  | "PENDING"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "SUSPENDED";

export type CaregiverVerificationStatus =
  | "NOT_VERIFIED"
  | "PENDING"
  | "UNDER_REVIEW"
  | "VERIFIED"
  | "REJECTED"
  | "EXPIRED"
  | "SUSPENDED";

export type DocumentVerificationStatus =
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "VERIFIED"
  | "REJECTED"
  | "EXPIRED";

export type BookingPaymentStatus =
  | "UNPAID"
  | "PENDING"
  | "PAID"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED"
  | "DISPUTED"
  | "FAILED";

export type VerificationSubjectType =
  | "PROVIDER"
  | "CENTER"
  | "CAREGIVER"
  | "DOCUMENT";

export type CenterListingStatus =
  | "ACTIVE"
  | "SUSPENDED"
  | "INACTIVE"
  | "PENDING_APPROVAL";

export type BookingStatus =
  | "REQUESTED"
  | "CONFIRMED"
  | "REJECTED"
  | "CANCELLED"
  | "CHECKED_IN"
  | "COMPLETED"
  | "EXPIRED"
  | "NO_SHOW";

export type IncidentStatus =
  | "REPORTED"
  | "UNDER_REVIEW"
  | "INVESTIGATING"
  | "RESOLVED"
  | "CLOSED";

export type IncidentSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ApiSuccessResponse<T> {
  success: true;
  message?: string;
  data: T;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
  };
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export interface AuthenticatedAdmin {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  status: AccountStatus;
  department: string;
  title: string;
  permissions: string[];
  lastLoginAt: string | null;
  sessionId: string;
  csrfToken: string;
  sessionExpiresAt: string;
}

export interface DashboardStats {
  totalUsers: number;
  totalParents: number;
  totalProviders: number;
  totalCenters: number;
  totalBookings: number;
  pendingVerifications: number;
  openIncidents: number;
  activeSubscriptions: number;
}

export interface DashboardAnalytics {
  monthlyActivity: Array<{
    month: string;
    userRegistrations: number;
    providerOnboarding: number;
    bookings: number;
    activeCenters: number;
  }>;
  bookingTrendsByStatus: Array<{
    status: BookingStatus;
    count: number;
  }>;
  providerApprovalRates: {
    approved: number;
    pending: number;
    underReview: number;
    rejected: number;
    suspended: number;
    approvalRatePercent: number;
  };
  centerCapacityUtilization: Array<{
    centerName: string;
    city: string;
    approvedCapacity: number;
    currentOccupancy: number;
    utilizationPercent: number;
  }>;
}

export interface DashboardActivity {
  recentProviders: Array<{
    id: string;
    organizationName: string;
    city: string;
    state: string;
    verificationStatus: VerificationStatus;
    createdAt: string;
  }>;
  pendingVerifications: Array<{
    id: string;
    providerId: string;
    organizationName: string;
    status: VerificationStatus;
    submittedAt: string;
    documentCount: number;
  }>;
  recentBookings: Array<{
    id: string;
    bookingReference: string;
    centerName: string;
    parentName: string;
    careType: string;
    status: BookingStatus;
    totalAmount: string;
    startTime: string;
  }>;
  recentIncidents: Array<{
    id: string;
    incidentReference: string;
    title: string;
    category: string;
    severity: IncidentSeverity;
    status: IncidentStatus;
    centerName: string;
    occurredAt: string;
  }>;
  recentAuditLogs: Array<{
    id: string;
    adminEmail: string;
    action: string;
    entityType: string;
    summary: string;
    createdAt: string;
  }>;
}
