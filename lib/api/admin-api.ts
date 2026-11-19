import type {
  AccountStatus,
  ApiSuccessResponse,
  AuthenticatedAdmin,
  BookingStatus,
  CaregiverVerificationStatus,
  CenterListingStatus,
  DashboardActivity,
  DashboardAnalytics,
  DashboardStats,
  DocumentScopeCategory,
  DocumentVerificationStatus,
  IncidentSeverity,
  IncidentStatus,
  MalwareScanStatus,
  UserRole,
  VerificationStatus,
  VerificationSubjectType,
} from "@/lib/admin/types";
import { adminAxiosClient } from "./axios-client";

// ==========================================
// 1. adminAuth module
// ==========================================
export const adminAuth = {
  async requestOtp(email: string) {
    const { data } = await adminAxiosClient.post<
      ApiSuccessResponse<{
        email: string;
        expiresInSeconds: number;
        resendCooldownSeconds: number;
      }>
    >("/admin/auth/request-otp", { email });
    return data;
  },

  async verifyOtp(email: string, otp: string) {
    const { data } = await adminAxiosClient.post<
      ApiSuccessResponse<{ admin: AuthenticatedAdmin }>
    >("/admin/auth/verify-otp", { email, otp });
    return data;
  },

  async resendOtp(email: string) {
    const { data } = await adminAxiosClient.post<
      ApiSuccessResponse<{
        email: string;
        expiresInSeconds: number;
        resendCooldownSeconds: number;
      }>
    >("/admin/auth/resend-otp", { email });
    return data;
  },

  async logout() {
    const { data } = await adminAxiosClient.post<
      ApiSuccessResponse<{ loggedOut: boolean }>
    >("/admin/auth/logout");
    return data;
  },

  async getMe() {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<{ admin: AuthenticatedAdmin }>
    >("/admin/auth/me");
    return data.data.admin;
  },
};

// ==========================================
// 2. dashboard module
// ==========================================
export const dashboard = {
  async getStats() {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<DashboardStats>
    >("/admin/dashboard/stats");
    return data.data;
  },

  async getAnalytics() {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<DashboardAnalytics>
    >("/admin/dashboard/analytics");
    return data.data;
  },

  async getActivity() {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<
        DashboardActivity & {
          notifications: Array<{
            id: string;
            type: string;
            title: string;
            message: string;
            isRead: boolean;
            createdAt: string;
          }>;
        }
      >
    >("/admin/dashboard/activity");
    return data.data;
  },
};

// ==========================================
// 3. users module
// ==========================================
export interface AdminUserListItem {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: UserRole;
  status: AccountStatus;
  emailVerified: boolean;
  lastLoginAt: string | null;
  suspendedReason: string | null;
  createdAt: string;
  bookingsCount: number;
}

export interface AdminUserDetail extends AdminUserListItem {
  suspendedAt: string | null;
  roles: Array<{
    id: string;
    role: UserRole;
    isActive: boolean;
    createdAt: string;
  }>;
  childrenSummary: Array<{
    id: string;
    displayInitial: string;
    ageGroup: string;
    ageMonths: number;
  }>;
  ownedProviders: Array<{
    id: string;
    organizationName: string;
    verificationStatus: VerificationStatus;
    city: string;
    state: string;
  }>;
  bookings: Array<{
    id: string;
    bookingReference: string;
    centerName: string;
    careType: string;
    status: BookingStatus;
    totalAmount: string;
    startTime: string;
    endTime: string;
  }>;
}

export const users = {
  async list(params?: {
    search?: string;
    role?: string;
    status?: string;
    page?: number;
    limit?: number;
  }) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminUserListItem[]>
    >("/admin/users", { params });
    return {
      items: data.data,
      meta: data.meta,
    };
  },

  async getById(id: string) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminUserDetail>
    >(`/admin/users/${id}`);
    return data.data;
  },

  async updateStatus(
    id: string,
    payload: { status: "ACTIVE" | "SUSPENDED" | "DISABLED"; reason: string }
  ) {
    const { data } = await adminAxiosClient.patch<
      ApiSuccessResponse<{
        id: string;
        status: AccountStatus;
        suspendedReason: string | null;
      }>
    >(`/admin/users/${id}/status`, payload);
    return data.data;
  },
};

// ==========================================
// 4. providers module
// ==========================================
export interface AdminProviderListItem {
  id: string;
  organizationName: string;
  registrationNumber: string;
  taxId: string | null;
  contactEmail: string;
  contactPhone: string;
  website: string | null;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  verificationStatus: VerificationStatus;
  subscriptionTier: string;
  subscriptionActive: boolean;
  isPublished: boolean;
  yearsInOperation: number | null;
  ownerName: string;
  centersCount: number;
  documentsCount: number;
  latestVerificationId: string | null;
  createdAt: string;
}

export const providers = {
  async list(params?: { search?: string; status?: string }) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminProviderListItem[]>
    >("/admin/providers", { params });
    return data.data;
  },

  async getById(id: string) {
    const { data } = await adminAxiosClient.get<ApiSuccessResponse<unknown>>(
      `/admin/providers/${id}`
    );
    return data.data;
  },
};

// ==========================================
// 5. verifications, centerVerifications, caregiverVerifications, verificationDocuments modules
// ==========================================
export interface AdminVerificationReviewHistoryItem {
  id: string;
  subjectType?: VerificationSubjectType;
  subjectId?: string;
  action?: string;
  decision?: string;
  previousStatus: string | null;
  newStatus: string;
  reviewerId?: string | null;
  reviewerName?: string | null;
  reviewerEmail: string | null;
  reviewComments: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export interface AdminVerificationDocumentItem {
  id: string;
  providerId: string;
  providerName?: string;
  centerId: string | null;
  centerName?: string | null;
  caregiverId: string | null;
  caregiverName?: string | null;
  verificationId?: string | null;
  documentCategory?: DocumentScopeCategory | string;
  documentType: string;
  documentTitle: string;
  originalFileName?: string | null;
  mimeType: string;
  fileSizeBytes: number;
  checksumSha256: string | null;
  malwareScanStatus: MalwareScanStatus | string;
  malwareScanProvider?: string | null;
  malwareScannedAt?: string | null;
  malwareScanResult?: string | null;
  quarantinedAt?: string | null;
  scannerConfigured?: boolean;
  contentAvailable?: boolean;
  checksumVerified?: boolean;
  storageScheme?: "s3" | "local" | "unmanaged";
  recentlyAccessedByCurrentAdmin?: boolean;
  signedAccessUrl?: string | null;
  status: DocumentVerificationStatus | string;
  isExpired: boolean;
  expiresAt: string | null;
  reviewedBy?: string | null;
  reviewedByEmail?: string | null;
  reviewerName?: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  rejectionReason: string | null;
  replacementRequested: boolean;
  accessUrl?: string;
  accessDescriptor?: string;
  history?: AdminVerificationReviewHistoryItem[];
  reviewHistory?: AdminVerificationReviewHistoryItem[];
  createdAt?: string;
}

export interface AdminVerificationItem {
  id: string;
  providerId: string;
  organizationName: string;
  registrationNumber: string;
  contactEmail: string;
  contactPhone: string;
  city: string;
  state: string;
  isPublished: boolean;
  status: VerificationStatus;
  reviewerId: string | null;
  reviewerName: string | null;
  reviewerEmail: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  reviewComments: string | null;
  rejectionReason: string | null;
  requestedDocuments: string[];
  checklistState: Record<string, boolean>;
  approvalEligibility?: {
    eligible: boolean;
    reasons: string[];
    requiredChecklistKeys?: readonly string[];
  };
  centers: Array<{
    id: string;
    name: string;
    city: string;
    approvedCapacity: number;
    is24x7: boolean;
    verificationStatus?: VerificationStatus;
    listingStatus: CenterListingStatus;
    verifiedAt?: string | null;
  }>;
  caregivers?: Array<{
    id: string;
    centerId: string;
    fullName: string;
    roleTitle: string;
    backgroundCheckStatus: CaregiverVerificationStatus | string;
    isActive: boolean;
    verifiedAt: string | null;
    verificationExpiresAt: string | null;
  }>;
  documents: AdminVerificationDocumentItem[];
  reviewHistory?: AdminVerificationReviewHistoryItem[];
}

export interface AdminCenterVerificationItem {
  id: string;
  centerId: string;
  providerId: string;
  providerName: string;
  providerVerificationStatus: VerificationStatus;
  centerName: string;
  city: string;
  state: string;
  address: string;
  approvedCapacity: number;
  ageGroupsSupported: string[];
  is24x7: boolean;
  verificationStatus: VerificationStatus;
  listingStatus: CenterListingStatus;
  reviewerId: string | null;
  reviewerName: string | null;
  reviewerEmail: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  verificationExpiresAt: string | null;
  reviewComments: string | null;
  rejectionReason: string | null;
  requestedDocuments: string[];
  checklistState: Record<string, boolean>;
  approvalEligibility: {
    eligible: boolean;
    reasons: string[];
    eligibleCaregiversCount: number;
  };
  caregivers: Array<{
    id: string;
    fullName: string;
    email: string;
    roleTitle: string;
    backgroundCheckStatus: CaregiverVerificationStatus | string;
    isExpired: boolean;
    isActive: boolean;
    verifiedAt: string | null;
    verificationExpiresAt: string | null;
  }>;
  documents: AdminVerificationDocumentItem[];
  reviewHistory: AdminVerificationReviewHistoryItem[];
}

export interface AdminCaregiverVerificationItem {
  id: string;
  caregiverId: string;
  centerId: string;
  centerName: string;
  providerId: string;
  providerName: string;
  fullName: string;
  email: string;
  phone: string | null;
  roleTitle: string;
  certifications: string[];
  yearsExperience: number;
  isActive: boolean;
  backgroundCheckStatus: CaregiverVerificationStatus;
  rawBackgroundCheckStatus: CaregiverVerificationStatus;
  isExpired: boolean;
  verifiedBy: string | null;
  reviewerName: string | null;
  reviewerEmail: string | null;
  verifiedAt: string | null;
  verificationExpiresAt: string | null;
  reviewComments: string | null;
  rejectionReason: string | null;
  checklistState: Record<string, boolean>;
  approvalEligibility: {
    eligible: boolean;
    reasons: string[];
  };
  documents: AdminVerificationDocumentItem[];
  reviewHistory: AdminVerificationReviewHistoryItem[];
}

export const verifications = {
  async list(params?: { status?: string; search?: string }) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminVerificationItem[]>
    >("/admin/verifications", { params });
    return data.data;
  },

  async approve(
    id: string,
    payload: {
      reviewComments: string;
      checklistState: {
        licenseVerified: boolean;
        organizationDetailsVerified: boolean;
      };
      expiresAt?: string;
    }
  ) {
    const { data } = await adminAxiosClient.post<ApiSuccessResponse<unknown>>(
      `/admin/verifications/${id}/approve`,
      payload
    );
    return data.data;
  },

  async reject(
    id: string,
    payload: {
      rejectionReason: string;
      reviewComments?: string;
      suspendProvider?: boolean;
    }
  ) {
    const { data } = await adminAxiosClient.post<ApiSuccessResponse<unknown>>(
      `/admin/verifications/${id}/reject`,
      payload
    );
    return data.data;
  },

  async requestDocuments(
    id: string,
    payload: { requestedDocuments: string[]; reviewComments: string }
  ) {
    const { data } = await adminAxiosClient.post<ApiSuccessResponse<unknown>>(
      `/admin/verifications/${id}/request-documents`,
      payload
    );
    return data.data;
  },
};

export const centerVerifications = {
  async list(params?: {
    status?: string;
    search?: string;
    providerId?: string;
  }) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminCenterVerificationItem[]>
    >("/admin/center-verifications", { params });
    return data.data;
  },

  async getById(id: string) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminCenterVerificationItem>
    >(`/admin/center-verifications/${id}`);
    return data.data;
  },

  async approve(
    centerId: string,
    payload: {
      reviewComments: string;
      checklistState: {
        operatingLicenseVerified: boolean;
        facilitySafetyVerified: boolean;
        caregiverQualificationVerified: boolean;
        capacityVerified: boolean;
        operatingHoursVerified: boolean;
        ageGroupsVerified: boolean;
      };
      safetyComplianceNotes?: string;
      activateListing?: boolean;
      expiresAt?: string;
    }
  ) {
    const { data } = await adminAxiosClient.post<ApiSuccessResponse<unknown>>(
      `/admin/center-verifications/${centerId}/approve`,
      payload
    );
    return data.data;
  },

  async reject(
    centerId: string,
    payload: {
      rejectionReason: string;
      reviewComments?: string;
      suspendCenter?: boolean;
    }
  ) {
    const { data } = await adminAxiosClient.post<ApiSuccessResponse<unknown>>(
      `/admin/center-verifications/${centerId}/reject`,
      payload
    );
    return data.data;
  },

  async requestDocuments(
    centerId: string,
    payload: { requestedDocuments: string[]; reviewComments: string }
  ) {
    const { data } = await adminAxiosClient.post<ApiSuccessResponse<unknown>>(
      `/admin/center-verifications/${centerId}/request-documents`,
      payload
    );
    return data.data;
  },
};

export const caregiverVerifications = {
  async list(params?: {
    status?: string;
    search?: string;
    providerId?: string;
    centerId?: string;
  }) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminCaregiverVerificationItem[]>
    >("/admin/caregiver-verifications", { params });
    return data.data;
  },

  async getById(id: string) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminCaregiverVerificationItem>
    >(`/admin/caregiver-verifications/${id}`);
    return data.data;
  },

  async approve(
    caregiverId: string,
    payload: {
      reviewComments: string;
      checklistState: {
        backgroundScreeningVerified: boolean;
        credentialsVerified: boolean;
      };
      expiresAt?: string;
    }
  ) {
    const { data } = await adminAxiosClient.post<ApiSuccessResponse<unknown>>(
      `/admin/caregiver-verifications/${caregiverId}/approve`,
      payload
    );
    return data.data;
  },

  async reject(
    caregiverId: string,
    payload: {
      rejectionReason: string;
      reviewComments?: string;
      suspendCaregiver?: boolean;
    }
  ) {
    const { data } = await adminAxiosClient.post<ApiSuccessResponse<unknown>>(
      `/admin/caregiver-verifications/${caregiverId}/reject`,
      payload
    );
    return data.data;
  },
};

export interface AdminDocumentDiagnosticsStatus {
  storageDriver: "s3" | "local" | "unconfigured";
  uploadsEnabled: boolean;
  storageMessage: string;
  scannerConfigured: boolean;
  maxUploadSizeBytes: number;
  productionReady: boolean;
}

export const verificationDocuments = {
  async getStatus() {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminDocumentDiagnosticsStatus>
    >("/admin/verification-documents/diagnostics/status");
    return data.data;
  },

  async list(params?: {
    status?: string;
    providerId?: string;
    centerId?: string;
    caregiverId?: string;
    search?: string;
  }) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminVerificationDocumentItem[]>
    >("/admin/verification-documents", { params });
    return data.data;
  },

  async getById(id: string) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminVerificationDocumentItem>
    >(`/admin/verification-documents/${id}`);
    return data.data;
  },

  async upload(
    payload:
      | FormData
      | {
          providerId: string;
          centerId?: string | null;
          caregiverId?: string | null;
          documentCategory: DocumentScopeCategory;
          documentType: string;
          documentTitle: string;
          fileName: string;
          mimeType?: "application/pdf" | "image/png" | "image/jpeg";
          fileBase64: string;
          expiresAt?: string | null;
        },
    options?: {
      onUploadProgress?: (percent: number) => void;
    }
  ) {
    const { data } = await adminAxiosClient.post<
      ApiSuccessResponse<{
        documentId: string;
        malwareScanStatus: MalwareScanStatus | string;
        status: string;
        scannerConfigured: boolean;
        storageDriver?: string;
      }>
    >("/admin/verification-documents/upload", payload, {
      onUploadProgress: options?.onUploadProgress
        ? (evt) => {
            const total = evt.total || 0;
            if (total > 0) {
              const pct = Math.min(100, Math.round((evt.loaded / total) * 100));
              options.onUploadProgress?.(pct);
            }
          }
        : undefined,
    });
    return data.data;
  },

  async scan(documentId: string) {
    const { data } = await adminAxiosClient.post<
      ApiSuccessResponse<{
        documentId: string;
        malwareScanStatus: MalwareScanStatus | string;
        malwareScanProvider: string | null;
        malwareScannedAt: string | null;
        malwareScanResult: string | null;
        configured: boolean;
      }>
    >(`/admin/verification-documents/${documentId}/scan`, {});
    return data.data;
  },

  async approve(
    documentId: string,
    payload: {
      reviewNotes: string;
      evidenceReviewed: true;
      reviewedChecksumSha256?: string;
      expiresAt?: string;
    }
  ) {
    const { data } = await adminAxiosClient.post<ApiSuccessResponse<unknown>>(
      `/admin/verification-documents/${documentId}/approve`,
      payload
    );
    return data.data;
  },

  async reject(
    documentId: string,
    payload: {
      rejectionReason: string;
      reviewNotes?: string;
      requestReplacement?: boolean;
    }
  ) {
    const { data } = await adminAxiosClient.post<ApiSuccessResponse<unknown>>(
      `/admin/verification-documents/${documentId}/reject`,
      payload
    );
    return data.data;
  },
};

// ==========================================
// 6. centers module
// ==========================================
export interface AdminCenterListItem {
  id: string;
  providerId: string;
  providerName: string;
  providerVerificationStatus?: VerificationStatus;
  name: string;
  slug: string;
  description: string | null;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  phone: string;
  email: string;
  ageGroupsSupported: string[];
  operatingHours: Record<
    string,
    { open: string; close: string; is24Hours?: boolean }
  >;
  is24x7: boolean;
  approvedCapacity: number;
  currentOccupancy: number;
  hourlyRate: string;
  dailyRate: string;
  verificationStatus: VerificationStatus;
  listingStatus: CenterListingStatus;
  verifiedBy?: string | null;
  verifiedAt?: string | null;
  verificationExpiresAt?: string | null;
  reviewComments?: string | null;
  rejectionReason?: string | null;
  suspendedReason: string | null;
  rating: string | null;
  caregiversCount: number;
  verifiedCaregiversCount?: number;
  openIncidentsCount: number;
  createdAt: string;
}

export interface AdminCenterDetail extends AdminCenterListItem {
  approvalEligibility?: {
    eligible: boolean;
    reasons: string[];
    eligibleCaregiversCount: number;
  };
  caregivers: Array<{
    id: string;
    fullName: string;
    email: string;
    phone: string | null;
    roleTitle: string;
    certifications: string[];
    backgroundCheckStatus: string;
    yearsExperience: number;
    isActive: boolean;
    verifiedBy?: string | null;
    verifiedAt?: string | null;
    verificationExpiresAt?: string | null;
    reviewComments?: string | null;
    rejectionReason?: string | null;
  }>;
  documents?: AdminVerificationDocumentItem[];
  reviewHistory?: AdminVerificationReviewHistoryItem[];
  capacityRules: Array<{
    id: string;
    ageGroup: string;
    maxChildren: number;
    caregiverRatio: string;
    isActive: boolean;
  }>;
  incidents: Array<{
    id: string;
    incidentReference: string;
    title: string;
    category: string;
    severity: IncidentSeverity;
    status: IncidentStatus;
    occurredAt: string;
  }>;
  activeBookingsCount: number;
}

export const centers = {
  async list(params?: {
    search?: string;
    listingStatus?: string;
    verificationStatus?: string;
    city?: string;
  }) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminCenterListItem[]>
    >("/admin/centers", { params });
    return data.data;
  },

  async getById(id: string) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminCenterDetail>
    >(`/admin/centers/${id}`);
    return data.data;
  },

  async updateStatus(
    id: string,
    payload: { listingStatus: CenterListingStatus; reason: string }
  ) {
    const { data } = await adminAxiosClient.patch<ApiSuccessResponse<unknown>>(
      `/admin/centers/${id}/status`,
      payload
    );
    return data.data;
  },
};

// ==========================================
// 7. bookings module
// ==========================================
export interface AdminBookingListItem {
  id: string;
  bookingReference: string;
  parentId: string;
  parentName: string;
  parentEmail: string;
  childAgeGroup: string;
  providerId: string;
  providerName: string;
  centerId: string;
  centerName: string;
  centerCapacity: number;
  centerOccupancy: number;
  capacityWarning: boolean;
  status: BookingStatus;
  careType: string;
  startTime: string;
  endTime: string;
  totalAmount: string;
  paymentStatus: string;
  hasConflict: boolean;
  cancellationReason: string | null;
  disputesCount: number;
  allowedTransitions: string[];
  createdAt: string;
}

export interface AdminBookingDetail {
  id: string;
  bookingReference: string;
  status: BookingStatus;
  careType: string;
  startTime: string;
  endTime: string;
  totalAmount: string;
  paymentStatus: string;
  hasConflict: boolean;
  cancellationReason: string | null;
  notes: string | null;
  allowedTransitions: string[];
  parent: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
  } | null;
  childSummary: {
    id: string;
    displayInitial: string;
    ageGroup: string;
    ageMonths: number;
  } | null;
  center: {
    id: string;
    name: string;
    city: string;
    approvedCapacity: number;
    currentOccupancy: number;
  } | null;
  provider: {
    id: string;
    organizationName: string;
  } | null;
  history: Array<{
    id: string;
    fromStatus: BookingStatus | null;
    toStatus: BookingStatus;
    changedByName: string;
    reason: string;
    createdAt: string;
  }>;
  disputes: Array<{
    id: string;
    disputeReference: string;
    reason: string;
    description: string;
    status: string;
    resolutionNotes: string | null;
    createdAt: string;
  }>;
}

export const bookings = {
  async list(params?: {
    search?: string;
    status?: string;
    centerId?: string;
    providerId?: string;
  }) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminBookingListItem[]>
    >("/admin/bookings", { params });
    return data.data;
  },

  async getById(id: string) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminBookingDetail>
    >(`/admin/bookings/${id}`);
    return data.data;
  },

  async getHistory(id: string) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminBookingDetail["history"]>
    >(`/admin/bookings/${id}/history`);
    return data.data;
  },

  async transitionStatus(
    id: string,
    payload: { status: BookingStatus; reason: string }
  ) {
    const { data } = await adminAxiosClient.patch<
      ApiSuccessResponse<AdminBookingDetail>
    >(`/admin/bookings/${id}/status`, payload);
    return data.data;
  },
};

// ==========================================
// 8. incidents module
// ==========================================
export interface AdminIncidentListItem {
  id: string;
  incidentReference: string;
  centerId: string;
  centerName: string;
  bookingId: string | null;
  bookingReference: string | null;
  assignedAdminId: string | null;
  assignedAdminName: string;
  assignedAdminEmail: string | null;
  category: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  description: string;
  resolutionOutcome: string | null;
  occurredAt: string;
  resolvedAt: string | null;
  createdAt: string;
}

export interface AdminIncidentDetail extends AdminIncidentListItem {
  centerCity: string;
  availableAdmins: Array<{
    id: string;
    name: string;
    email: string;
    role: string;
  }>;
  activities: Array<{
    id: string;
    actionType: string;
    fromStatus: IncidentStatus | null;
    toStatus: IncidentStatus | null;
    note: string;
    actorName: string;
    actorEmail: string | null;
    createdAt: string;
  }>;
}

export const incidents = {
  async list(params?: {
    status?: string;
    severity?: string;
    category?: string;
    search?: string;
  }) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminIncidentListItem[]>
    >("/admin/incidents", { params });
    return data.data;
  },

  async getById(id: string) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminIncidentDetail>
    >(`/admin/incidents/${id}`);
    return data.data;
  },

  async updateStatus(
    id: string,
    payload: {
      status: IncidentStatus;
      assignedAdminId?: string | null;
      resolutionOutcome?: string;
      note: string;
    }
  ) {
    const { data } = await adminAxiosClient.patch<
      ApiSuccessResponse<AdminIncidentDetail>
    >(`/admin/incidents/${id}/status`, payload);
    return data.data;
  },

  async addNote(
    id: string,
    payload: { note: string; assignedAdminId?: string }
  ) {
    const { data } = await adminAxiosClient.post<
      ApiSuccessResponse<AdminIncidentDetail>
    >(`/admin/incidents/${id}/notes`, payload);
    return data.data;
  },
};

// ==========================================
// 9. reports & auditLogs module
// ==========================================
export interface AdminReportsSummary {
  financialSummary: {
    totalGrossBookingValue: string;
    paidBookingsCount: number;
    disputedBookingsCount: number;
    openDisputesCount: number;
    activeProviderSubscriptions: number;
  };
  complianceMetrics: {
    totalProviders: number;
    approvedProviders: number;
    pendingOrUnderReviewProviders: number;
    centers24x7Count: number;
    resolvedIncidentsCount: number;
    openIncidentsCount: number;
  };
  cityDistribution: Array<{
    city: string;
    centersCount: number;
    totalCapacity: number;
    totalOccupancy: number;
  }>;
  roleBreakdown: Array<{
    role: string;
    count: number;
  }>;
}

export interface AdminAuditLogEntry {
  id: string;
  adminUserId: string | null;
  adminEmail: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  previousState: Record<string, unknown> | null;
  newState: Record<string, unknown> | null;
  ipAddress: string | null;
  integrityHash: string;
  createdAt: string;
}

export const reports = {
  async getSummary() {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminReportsSummary>
    >("/admin/reports");
    return data.data;
  },

  async listAuditLogs(params?: {
    action?: string;
    entityType?: string;
    search?: string;
    limit?: number;
  }) {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminAuditLogEntry[]>
    >("/admin/audit-logs", { params });
    return data.data;
  },
};

// ==========================================
// 10. settings module
// ==========================================
export interface AdminPlatformSettingItem {
  id: string;
  settingKey: string;
  settingValue: unknown;
  category: string;
  description: string | null;
  updatedAt: string;
}

export const settings = {
  async getAll() {
    const { data } = await adminAxiosClient.get<
      ApiSuccessResponse<AdminPlatformSettingItem[]>
    >("/admin/settings");
    return data.data;
  },

  async updateAll(
    items: Array<{
      settingKey: string;
      settingValue: unknown;
      category?:
        | "GENERAL"
        | "SECURITY"
        | "VERIFICATION"
        | "BOOKINGS"
        | "NOTIFICATIONS";
      description?: string;
    }>
  ) {
    const { data } = await adminAxiosClient.patch<
      ApiSuccessResponse<AdminPlatformSettingItem[]>
    >("/admin/settings", { settings: items });
    return data.data;
  },
};
