import { and, desc, eq, isNull } from "drizzle-orm";
import { db, type DbClientOrTx } from "../../config/db";
import {
  adminAuditLogs,
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
  platformSettings,
  providers,
  providerVerifications,
  safetyIncidents,
  userRoles,
  users,
  verificationDocuments,
  verificationReviewHistory,
} from "../../config/schema";
import type {
  AccountStatus,
  AuthenticatedAdmin,
  BookingStatus,
  CaregiverVerificationStatus,
  CenterListingStatus,
  DocumentVerificationStatus,
  IncidentStatus,
  MalwareScanStatus,
  VerificationStatus,
} from "../../lib/admin/types";
import {
  ALLOWED_BOOKING_TRANSITIONS,
  CAREGIVER_REQUIRED_CHECKLIST_KEYS,
  CENTER_REQUIRED_CHECKLIST_KEYS,
  PROVIDER_REQUIRED_CHECKLIST_KEYS,
} from "../../lib/admin/validation";
import { createSignedDocumentAccessToken } from "../security/crypto";
import { AdminAuthError } from "./admin-auth.service";
import { recordAdminAuditLog } from "./audit.service";
import { isMalwareScannerConfigured } from "./document-scanner.service";
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  isManagedPrivateStorageReference,
  MAX_DOCUMENT_SIZE_BYTES,
  verifyStoredDocumentAccessible,
} from "./document-storage.service";

/**
 * Applies PostgreSQL `FOR UPDATE` row locking when running on Drizzle PG query builders,
 * while remaining compatible with lightweight mock query objects.
 */
async function executeWithRowLock<T>(queryBuilder: {
  for?: (strength: "update") => Promise<T[]>;
  then: PromiseLike<T[]>["then"];
}): Promise<T[]> {
  if (typeof queryBuilder.for === "function") {
    return queryBuilder.for("update");
  }
  return queryBuilder as unknown as Promise<T[]>;
}

/**
 * A document can only satisfy compliance verification when:
 * - status is VERIFIED
 * - not expired
 * - malwareScanStatus is strictly CLEAN (never PENDING/SCANNING/INFECTED/ERROR)
 * - trusted backend scan metadata (malwareScannedAt & malwareScanProvider) is present
 * - not quarantined
 */
export function isDocumentCurrentlyValid(
  doc: {
    status: string;
    expiresAt: Date | null;
    malwareScanStatus?: string | null;
    malwareScannedAt?: Date | null;
    malwareScanProvider?: string | null;
    quarantinedAt?: Date | null;
  },
  now = new Date()
): boolean {
  if (doc.status !== "VERIFIED") return false;
  if (doc.quarantinedAt) return false;
  if (doc.malwareScanStatus !== "CLEAN") return false;
  if (!doc.malwareScannedAt || !doc.malwareScanProvider) return false;
  if (doc.expiresAt && doc.expiresAt <= now) return false;
  return true;
}

export function isProviderScopedDocument(doc: {
  centerId: string | null;
  caregiverId?: string | null;
  documentCategory?: string | null;
}): boolean {
  if (doc.centerId !== null && doc.centerId !== undefined) return false;
  if (doc.caregiverId !== null && doc.caregiverId !== undefined) return false;
  if (doc.documentCategory && doc.documentCategory !== "PROVIDER") return false;
  return true;
}

export function isCenterScopedDocument(
  doc: {
    providerId: string;
    centerId: string | null;
    caregiverId?: string | null;
    documentCategory?: string | null;
  },
  centerId: string,
  providerId: string
): boolean {
  if (doc.providerId !== providerId) return false;
  if (doc.centerId !== centerId) return false;
  if (doc.caregiverId !== null && doc.caregiverId !== undefined) return false;
  if (doc.documentCategory && doc.documentCategory !== "CENTER") return false;
  return true;
}

export function isCaregiverEligibleForStaffing(
  caregiver: {
    isActive: boolean;
    backgroundCheckStatus: string;
    verificationExpiresAt?: Date | null;
  },
  now = new Date()
): boolean {
  if (!caregiver.isActive) return false;
  if (caregiver.backgroundCheckStatus !== "VERIFIED") return false;
  if (
    caregiver.verificationExpiresAt &&
    caregiver.verificationExpiresAt <= now
  ) {
    return false;
  }
  return true;
}

export function getEffectiveCaregiverStatus(
  caregiver: {
    isActive: boolean;
    backgroundCheckStatus: string;
    verificationExpiresAt?: Date | null;
  },
  now = new Date()
): CaregiverVerificationStatus {
  if (
    caregiver.backgroundCheckStatus === "VERIFIED" &&
    caregiver.verificationExpiresAt &&
    caregiver.verificationExpiresAt <= now
  ) {
    return "EXPIRED";
  }
  return (caregiver.backgroundCheckStatus ||
    "NOT_VERIFIED") as CaregiverVerificationStatus;
}

function buildPrivateDocumentAccessDescriptor(
  docId: string,
  adminId?: string,
  canReadContent = false
): string {
  const base = `/api/v1/admin/verification-documents/${docId}/content`;
  if (canReadContent && adminId) {
    const token = createSignedDocumentAccessToken(docId, adminId, 120);
    return `${base}?token=${encodeURIComponent(token)}`;
  }
  return base;
}

async function safeSelectTable<T>(queryFn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await queryFn();
  } catch {
    return [];
  }
}

async function appendVerificationReviewHistory(
  tx: Pick<DbClientOrTx, "insert">,
  entry: {
    subjectType: "PROVIDER" | "CENTER" | "CAREGIVER" | "DOCUMENT";
    subjectId: string;
    verificationId?: string | null;
    previousStatus?: string | null;
    newStatus: string;
    decision: string;
    reviewerId: string;
    reviewerEmail: string;
    reviewComments?: string | null;
    rejectionReason?: string | null;
    evidenceSnapshot?: Record<string, unknown>;
    createdAt?: Date;
  }
): Promise<void> {
  await tx.insert(verificationReviewHistory).values({
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    verificationId: entry.verificationId ?? null,
    previousStatus: entry.previousStatus ?? null,
    newStatus: entry.newStatus,
    decision: entry.decision,
    reviewerId: entry.reviewerId,
    reviewerEmail: entry.reviewerEmail,
    reviewComments: entry.reviewComments ?? null,
    rejectionReason: entry.rejectionReason ?? null,
    evidenceSnapshot: entry.evidenceSnapshot ?? {},
    createdAt: entry.createdAt ?? new Date(),
  });
}

// ==========================================
// 1. User Management
// ==========================================

export async function listAdminUsers(filters: {
  search?: string;
  role?: string;
  status?: string;
  page?: number;
  limit?: number;
}) {

  const [allUsers, allBookings] = await Promise.all([
    db.select().from(users).orderBy(desc(users.createdAt)),
    db.select({ id: bookings.id, parentId: bookings.parentId }).from(bookings),
  ]);

  const search = (filters.search || "").trim().toLowerCase();
  const filtered = allUsers.filter((u) => {
    if (filters.role && filters.role !== "ALL" && u.role !== filters.role) {
      return false;
    }
    if (
      filters.status &&
      filters.status !== "ALL" &&
      u.status !== filters.status
    ) {
      return false;
    }
    if (
      search &&
      !u.name.toLowerCase().includes(search) &&
      !u.email.toLowerCase().includes(search)
    ) {
      return false;
    }
    return true;
  });

  const page = Math.max(1, Number(filters.page || 1));
  const limit = Math.min(100, Math.max(1, Number(filters.limit || 25)));
  const start = (page - 1) * limit;
  const paginated = filtered.slice(start, start + limit);

  return {
    items: paginated.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      phone: u.phone,
      role: u.role,
      status: u.status,
      emailVerified: u.emailVerified,
      lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
      suspendedReason: u.suspendedReason,
      createdAt: u.createdAt.toISOString(),
      bookingsCount: allBookings.filter((b) => b.parentId === u.id).length,
    })),
    meta: {
      page,
      limit,
      total: filtered.length,
      totalPages: Math.max(1, Math.ceil(filtered.length / limit)),
    },
  };
}

export async function getAdminUserById(userId: string) {

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new AdminAuthError("USER_NOT_FOUND", "User account not found.", 404);
  }

  const [rolesRows, userBookings, userChildren, allCenters, ownedProviders] =
    await Promise.all([
      db.select().from(userRoles).where(eq(userRoles.userId, user.id)),
      db
        .select()
        .from(bookings)
        .where(eq(bookings.parentId, user.id))
        .orderBy(desc(bookings.createdAt)),
      db.select().from(children).where(eq(children.parentId, user.id)),
      db.select().from(centers),
      db.select().from(providers).where(eq(providers.ownerUserId, user.id)),
    ]);

  const centerMap = new Map(allCenters.map((c) => [c.id, c]));

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    role: user.role,
    status: user.status,
    emailVerified: user.emailVerified,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    suspendedReason: user.suspendedReason,
    suspendedAt: user.suspendedAt ? user.suspendedAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
    roles: rolesRows.map((r) => ({
      id: r.id,
      role: r.role,
      isActive: r.isActive,
      createdAt: r.createdAt.toISOString(),
    })),
    // Controlled access: only expose child age group & first initial, never sensitive medical details
    childrenSummary: userChildren.map((ch) => ({
      id: ch.id,
      displayInitial: `${ch.firstName.charAt(0)}.`,
      ageGroup: ch.ageGroup,
      ageMonths: ch.ageMonths,
    })),
    ownedProviders: ownedProviders.map((p) => ({
      id: p.id,
      organizationName: p.organizationName,
      verificationStatus: p.verificationStatus,
      city: p.city,
      state: p.state,
    })),
    bookings: userBookings.map((b) => ({
      id: b.id,
      bookingReference: b.bookingReference,
      centerName: centerMap.get(b.centerId)?.name ?? "Unknown Centre",
      careType: b.careType,
      status: b.status,
      totalAmount: b.totalAmount,
      startTime: b.startTime.toISOString(),
      endTime: b.endTime.toISOString(),
    })),
  };
}

export async function updateAdminUserStatus(params: {
  userId: string;
  status: AccountStatus;
  reason: string;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const now = new Date();
  const isSuspending = params.status !== "ACTIVE";

  return db.transaction(async (tx) => {
    const [target] = await executeWithRowLock(
      tx.select().from(users).where(eq(users.id, params.userId)).limit(1)
    );

    if (!target) {
      throw new AdminAuthError("USER_NOT_FOUND", "User account not found.", 404);
    }

    if (target.id === params.admin.id) {
      throw new AdminAuthError(
        "SELF_STATUS_MODIFICATION_FORBIDDEN",
        "Administrators cannot suspend or disable their own active account.",
        400
      );
    }

    if (target.role === "SUPER_ADMIN" && params.admin.role !== "SUPER_ADMIN") {
      throw new AdminAuthError(
        "INSUFFICIENT_ROLE_PRIVILEGES",
        "Only a SUPER_ADMIN may modify the account status of another SUPER_ADMIN.",
        403
      );
    }

    const [updated] = await tx
      .update(users)
      .set({
        status: params.status,
        suspendedReason: isSuspending ? params.reason : null,
        suspendedAt: isSuspending ? now : null,
        updatedAt: now,
      })
      .where(eq(users.id, target.id))
      .returning();

    // Synchronize user_roles active state
    await tx
      .update(userRoles)
      .set({ isActive: params.status === "ACTIVE" })
      .where(eq(userRoles.userId, target.id));

    // If suspending an admin account, also revoke their active sessions & admin profile approval
    if (
      isSuspending &&
      (target.role === "ADMIN" || target.role === "SUPER_ADMIN")
    ) {
      await tx
        .update(adminSessions)
        .set({
          revokedAt: now,
          revokedReason: `ACCOUNT_${params.status}: ${params.reason}`,
        })
        .where(
          and(
            eq(adminSessions.userId, target.id),
            isNull(adminSessions.revokedAt)
          )
        );

      await tx
        .update(adminProfiles)
        .set({ isApproved: false, updatedAt: now })
        .where(eq(adminProfiles.userId, target.id));
    } else if (
      params.status === "ACTIVE" &&
      (target.role === "ADMIN" || target.role === "SUPER_ADMIN")
    ) {
      await tx
        .update(adminProfiles)
        .set({ isApproved: true, updatedAt: now })
        .where(eq(adminProfiles.userId, target.id));
    }

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: `USER_STATUS_${params.status}`,
        entityType: "USER",
        entityId: target.id,
        summary: `Updated status of ${target.email} from ${target.status} to ${params.status}. Reason: ${params.reason}`,
        previousState: { status: target.status, reason: target.suspendedReason },
        newState: { status: params.status, reason: params.reason },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );

    return {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      role: updated.role,
      status: updated.status,
      suspendedReason: updated.suspendedReason,
      updatedAt: updated.updatedAt.toISOString(),
    };
  });
}

// ==========================================
// 2. Provider & Verification Management
// ==========================================

export async function listAdminProviders(filters: {
  search?: string;
  verificationStatus?: string;
}) {

  const [allProviders, allCenters, allDocs, allVerifications, allUsers] =
    await Promise.all([
      db.select().from(providers).orderBy(desc(providers.createdAt)),
      db.select().from(centers),
      db.select().from(verificationDocuments),
      db
        .select()
        .from(providerVerifications)
        .orderBy(desc(providerVerifications.submittedAt)),
      db.select().from(users),
    ]);

  const userMap = new Map(allUsers.map((u) => [u.id, u]));
  const search = (filters.search || "").trim().toLowerCase();

  return allProviders
    .filter((p) => {
      if (
        filters.verificationStatus &&
        filters.verificationStatus !== "ALL" &&
        p.verificationStatus !== filters.verificationStatus
      ) {
        return false;
      }
      if (
        search &&
        !p.organizationName.toLowerCase().includes(search) &&
        !p.registrationNumber.toLowerCase().includes(search) &&
        !p.city.toLowerCase().includes(search) &&
        !p.contactEmail.toLowerCase().includes(search)
      ) {
        return false;
      }
      return true;
    })
    .map((p) => {
      const latestVerification = allVerifications.find(
        (v) => v.providerId === p.id
      );
      const owner = userMap.get(p.ownerUserId);
      return {
        id: p.id,
        organizationName: p.organizationName,
        registrationNumber: p.registrationNumber,
        taxId: p.taxId,
        contactEmail: p.contactEmail,
        contactPhone: p.contactPhone,
        website: p.website,
        address: p.address,
        city: p.city,
        state: p.state,
        postalCode: p.postalCode,
        verificationStatus: p.verificationStatus,
        subscriptionTier: p.subscriptionTier,
        subscriptionActive: p.subscriptionActive,
        isPublished: p.isPublished,
        yearsInOperation: p.yearsInOperation,
        ownerName: owner?.name ?? "Provider Owner",
        centersCount: allCenters.filter((c) => c.providerId === p.id).length,
        documentsCount: allDocs.filter((d) => d.providerId === p.id).length,
        latestVerificationId: latestVerification?.id ?? null,
        createdAt: p.createdAt.toISOString(),
      };
    });
}

export async function getAdminProviderById(providerId: string) {

  const [provider] = await db
    .select()
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1);

  if (!provider) {
    throw new AdminAuthError(
      "PROVIDER_NOT_FOUND",
      "Childcare provider not found.",
      404
    );
  }

  const [providerCenters, docs, verifications, allUsers] = await Promise.all([
    db.select().from(centers).where(eq(centers.providerId, provider.id)),
    db
      .select()
      .from(verificationDocuments)
      .where(eq(verificationDocuments.providerId, provider.id)),
    db
      .select()
      .from(providerVerifications)
      .where(eq(providerVerifications.providerId, provider.id))
      .orderBy(desc(providerVerifications.submittedAt)),
    db.select().from(users),
  ]);

  const userMap = new Map(allUsers.map((u) => [u.id, u]));
  const owner = userMap.get(provider.ownerUserId);

  return {
    ...provider,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
    owner: owner
      ? {
          id: owner.id,
          name: owner.name,
          email: owner.email,
          status: owner.status,
        }
      : null,
    centers: providerCenters.map((c) => ({
      id: c.id,
      name: c.name,
      city: c.city,
      state: c.state,
      is24x7: c.is24x7,
      approvedCapacity: c.approvedCapacity,
      currentOccupancy: c.currentOccupancy,
      verificationStatus: c.verificationStatus,
      listingStatus: c.listingStatus,
    })),
    documents: docs.map((d) => ({
      id: d.id,
      documentType: d.documentType,
      documentTitle: d.documentTitle,
      mimeType: d.mimeType,
      fileSizeBytes: d.fileSizeBytes,
      checksumSha256: d.checksumSha256,
      status: d.status,
      expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
      reviewedByEmail: d.reviewedBy ? userMap.get(d.reviewedBy)?.email ?? null : null,
      reviewedAt: d.reviewedAt ? d.reviewedAt.toISOString() : null,
      reviewNotes: d.reviewNotes,
      createdAt: d.createdAt.toISOString(),
    })),
    verifications: verifications.map((v) => ({
      id: v.id,
      status: v.status,
      reviewerName: v.reviewerId ? userMap.get(v.reviewerId)?.name ?? null : null,
      reviewerEmail: v.reviewerId ? userMap.get(v.reviewerId)?.email ?? null : null,
      submittedAt: v.submittedAt.toISOString(),
      reviewedAt: v.reviewedAt ? v.reviewedAt.toISOString() : null,
      reviewComments: v.reviewComments,
      rejectionReason: v.rejectionReason,
      requestedDocuments: v.requestedDocuments,
      checklistState: v.checklistState,
    })),
  };
}

export function evaluateProviderApprovalEligibility(params: {
  provider: {
    id: string;
    ownerUserId: string;
    organizationName: string;
    registrationNumber: string;
    contactEmail: string;
    contactPhone: string;
    address: string;
  };
  verification: {
    id: string;
    status: string;
    requestedDocuments: string[] | null;
    documentReferences: string[] | null;
    checklistState: Record<string, boolean> | null;
  };
  providerDocuments: Array<{
    id: string;
    providerId: string;
    centerId: string | null;
    caregiverId?: string | null;
    documentCategory?: string | null;
    documentType: string;
    documentTitle: string;
    status: string;
    expiresAt: Date | null;
    malwareScanStatus?: string | null;
    malwareScannedAt?: Date | null;
    malwareScanProvider?: string | null;
    quarantinedAt?: Date | null;
  }>;
  submittedChecklist?: Record<string, boolean>;
  enforceSubmittedChecklist?: boolean;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const blockingReasons: string[] = [];

  if (
    params.verification.status !== "PENDING" &&
    params.verification.status !== "UNDER_REVIEW"
  ) {
    blockingReasons.push(
      `Provider verification is currently '${params.verification.status}' and is not in a reviewable state (PENDING or UNDER_REVIEW).`
    );
  }

  // Strictly enforce organization-scoped (PROVIDER) documents only.
  // Never allow centre-scoped or caregiver-scoped documents to satisfy organization approval.
  const orgScopedDocs = params.providerDocuments.filter(
    (d) =>
      d.providerId === params.provider.id && isProviderScopedDocument(d)
  );

  if (orgScopedDocs.length === 0) {
    blockingReasons.push(
      "At least one organization-scoped verification document (category PROVIDER, not centre or caregiver scoped) must be submitted and verified."
    );
  }

  const referencedIds = params.verification.documentReferences ?? [];
  const requiredDocsToInspect =
    referencedIds.length > 0
      ? orgScopedDocs.filter((d) => referencedIds.includes(d.id))
      : orgScopedDocs;

  if (
    referencedIds.length > 0 &&
    requiredDocsToInspect.length < referencedIds.length
  ) {
    blockingReasons.push(
      "One or more referenced verification documents are missing or are not organization-scoped (PROVIDER) documents."
    );
  }

  const infectedOrUnscannedDocs = requiredDocsToInspect.filter(
    (d) =>
      d.quarantinedAt ||
      d.malwareScanStatus !== "CLEAN" ||
      !d.malwareScannedAt ||
      !d.malwareScanProvider
  );
  if (infectedOrUnscannedDocs.length > 0) {
    blockingReasons.push(
      `Organization document(s) lack trusted CLEAN malware scan completion: ${infectedOrUnscannedDocs.map((d) => `${d.documentTitle} (${d.malwareScanStatus ?? "PENDING"})`).join(", ")}.`
    );
  }

  const rejectedDocs = requiredDocsToInspect.filter(
    (d) => d.status === "REJECTED"
  );
  if (rejectedDocs.length > 0) {
    blockingReasons.push(
      `Rejected organization document(s) cannot satisfy approval: ${rejectedDocs.map((d) => d.documentTitle).join(", ")}.`
    );
  }

  const expiredDocs = requiredDocsToInspect.filter(
    (d) => d.status === "EXPIRED" || (d.expiresAt !== null && d.expiresAt <= now)
  );
  if (expiredDocs.length > 0) {
    blockingReasons.push(
      `Expired organization document(s) must be renewed before approval: ${expiredDocs.map((d) => d.documentTitle).join(", ")}.`
    );
  }

  const unverifiedDocs = requiredDocsToInspect.filter(
    (d) =>
      d.status !== "VERIFIED" && d.status !== "REJECTED" && d.status !== "EXPIRED"
  );
  if (unverifiedDocs.length > 0) {
    blockingReasons.push(
      `All required organization documents must be individually VERIFIED before provider approval (${unverifiedDocs.length} unverified: ${unverifiedDocs.map((d) => d.documentTitle).join(", ")}).`
    );
  }

  const verifiedValidDocs = requiredDocsToInspect.filter((d) =>
    isDocumentCurrentlyValid(d, now)
  );
  if (orgScopedDocs.length > 0 && verifiedValidDocs.length === 0) {
    blockingReasons.push(
      "No valid, malware-clean, non-expired VERIFIED organization documents are present."
    );
  }

  const requestedTypes = params.verification.requestedDocuments ?? [];
  for (const reqType of requestedTypes) {
    const hasVerifiedType = orgScopedDocs.some(
      (d) =>
        d.documentType.toUpperCase() === reqType.toUpperCase() &&
        isDocumentCurrentlyValid(d, now)
    );
    if (!hasVerifiedType) {
      blockingReasons.push(
        `Requested compliance document '${reqType}' has not been uploaded and verified.`
      );
    }
  }

  const effectiveChecklist: Record<string, boolean> = {
    ...(params.verification.checklistState ?? {}),
    ...(params.submittedChecklist ?? {}),
  };

  if (params.enforceSubmittedChecklist) {
    for (const key of PROVIDER_REQUIRED_CHECKLIST_KEYS) {
      if (params.submittedChecklist?.[key] !== true) {
        blockingReasons.push(
          `Mandatory provider checklist item '${key}' must be explicitly verified (true).`
        );
      }
    }
  }

  for (const [key, val] of Object.entries(effectiveChecklist)) {
    if (val === false) {
      blockingReasons.push(
        `Checklist requirement '${key}' is marked incomplete (false).`
      );
    }
  }

  return {
    eligible: blockingReasons.length === 0,
    blockingReasons,
    requiredChecklistKeys: PROVIDER_REQUIRED_CHECKLIST_KEYS,
    verifiedDocumentsCount: verifiedValidDocs.length,
    totalOrganizationDocumentsCount: orgScopedDocs.length,
    effectiveChecklist,
  };
}

export async function listAdminVerifications(filters: {
  status?: string;
  search?: string;
}) {
  const [
    verificationsRows,
    allProviders,
    allCenters,
    allDocs,
    allUsers,
    reviewHistoryRows,
  ] = await Promise.all([
    db
      .select()
      .from(providerVerifications)
      .orderBy(desc(providerVerifications.submittedAt)),
    db.select().from(providers),
    db.select().from(centers),
    db.select().from(verificationDocuments),
    db.select().from(users),
    safeSelectTable(() =>
      db
        .select()
        .from(verificationReviewHistory)
        .orderBy(desc(verificationReviewHistory.createdAt))
    ),
  ]);

  const providerMap = new Map(allProviders.map((p) => [p.id, p]));
  const userMap = new Map(allUsers.map((u) => [u.id, u]));
  const search = (filters.search || "").trim().toLowerCase();
  const now = new Date();

  return verificationsRows
    .map((v) => {
      const prov = providerMap.get(v.providerId);
      const provCenters = allCenters.filter(
        (c) => c.providerId === v.providerId
      );
      const provDocs = allDocs.filter((d) => d.providerId === v.providerId);
      const reviewer = v.reviewerId ? userMap.get(v.reviewerId) : null;

      const eligibility = prov
        ? evaluateProviderApprovalEligibility({
            provider: prov,
            verification: v,
            providerDocuments: provDocs,
            now,
          })
        : {
            eligible: false,
            blockingReasons: ["Associated provider record is missing."],
            verifiedDocumentsCount: 0,
            totalOrganizationDocumentsCount: 0,
            effectiveChecklist: v.checklistState ?? {},
          };

      const history = reviewHistoryRows
        .filter(
          (h) =>
            h.verificationId === v.id ||
            (h.subjectType === "PROVIDER" && h.subjectId === v.providerId)
        )
        .map((h) => ({
          id: h.id,
          previousStatus: h.previousStatus,
          newStatus: h.newStatus,
          decision: h.decision,
          reviewerEmail: h.reviewerEmail,
          reviewComments: h.reviewComments,
          rejectionReason: h.rejectionReason,
          createdAt: h.createdAt.toISOString(),
        }));

      return {
        id: v.id,
        providerId: v.providerId,
        organizationName: prov?.organizationName ?? "Unknown Provider",
        registrationNumber: prov?.registrationNumber ?? "N/A",
        contactEmail: prov?.contactEmail ?? "",
        contactPhone: prov?.contactPhone ?? "",
        city: prov?.city ?? "",
        state: prov?.state ?? "",
        isPublished: prov?.isPublished ?? false,
        status: v.status,
        reviewerId: v.reviewerId,
        reviewerName: reviewer?.name ?? null,
        reviewerEmail: reviewer?.email ?? null,
        submittedAt: v.submittedAt.toISOString(),
        reviewedAt: v.reviewedAt ? v.reviewedAt.toISOString() : null,
        expiresAt: v.expiresAt ? v.expiresAt.toISOString() : null,
        reviewComments: v.reviewComments,
        rejectionReason: v.rejectionReason,
        requestedDocuments: v.requestedDocuments ?? [],
        checklistState: v.checklistState ?? {},
        approvalEligibility: {
          eligible: eligibility.eligible,
          reasons: eligibility.blockingReasons,
          blockingReasons: eligibility.blockingReasons,
          requiredChecklistKeys: PROVIDER_REQUIRED_CHECKLIST_KEYS,
          verifiedDocumentsCount: eligibility.verifiedDocumentsCount,
          totalOrganizationDocumentsCount:
            eligibility.totalOrganizationDocumentsCount,
        },
        history,
        reviewHistory: history,
        centers: provCenters.map((c) => ({
          id: c.id,
          name: c.name,
          city: c.city,
          approvedCapacity: c.approvedCapacity,
          is24x7: c.is24x7,
          verificationStatus: c.verificationStatus,
          listingStatus: c.listingStatus,
        })),
        documents: provDocs.map((d) => {
          const isExpired = d.expiresAt !== null && d.expiresAt <= now;
          const scanStatus = (d.malwareScanStatus || "PENDING") as MalwareScanStatus;
          return {
            id: d.id,
            providerId: d.providerId,
            centerId: d.centerId,
            caregiverId: d.caregiverId ?? null,
            documentCategory: d.documentCategory ?? "PROVIDER",
            documentType: d.documentType,
            documentTitle: d.documentTitle,
            originalFileName: d.originalFileName ?? null,
            mimeType: d.mimeType,
            fileSizeBytes: d.fileSizeBytes,
            status: isExpired && d.status !== "REJECTED" ? "EXPIRED" : d.status,
            isExpired,
            malwareScanStatus: scanStatus,
            malwareScanProvider: d.malwareScanProvider ?? null,
            malwareScannedAt: d.malwareScannedAt
              ? d.malwareScannedAt.toISOString()
              : null,
            malwareScanResult: d.malwareScanResult ?? null,
            quarantinedAt: d.quarantinedAt
              ? d.quarantinedAt.toISOString()
              : null,
            scannerConfigured: isMalwareScannerConfigured(),
            checksumSha256: d.checksumSha256,
            expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
            reviewNotes: d.reviewNotes,
            rejectionReason: d.rejectionReason ?? null,
            replacementRequested: d.replacementRequested ?? false,
            accessUrl: buildPrivateDocumentAccessDescriptor(d.id),
          };
        }),
      };
    })
    .filter((item) => {
      if (
        filters.status &&
        filters.status !== "ALL" &&
        item.status !== filters.status
      ) {
        return false;
      }
      if (
        search &&
        !item.organizationName.toLowerCase().includes(search) &&
        !item.registrationNumber.toLowerCase().includes(search) &&
        !item.city.toLowerCase().includes(search)
      ) {
        return false;
      }
      return true;
    });
}

export async function approveProviderVerification(params: {
  verificationId: string;
  reviewComments: string;
  checklistState: Record<string, boolean>;
  expiresAt?: string;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const trimmedComments = (params.reviewComments || "").trim();
  if (trimmedComments.length < 3) {
    throw new AdminAuthError(
      "REVIEW_COMMENTS_REQUIRED",
      "Review comments of at least 3 characters are required when approving a provider.",
      400
    );
  }

  const now = new Date();
  const expiresAt = params.expiresAt
    ? new Date(params.expiresAt)
    : new Date(now.getTime() + 365 * 86_400_000);

  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
    throw new AdminAuthError(
      "INVALID_EXPIRATION_DATE",
      "Provider verification expiration date must be a valid future timestamp.",
      400
    );
  }

  const txResult = await db.transaction(async (tx) => {
    const [verification] = await executeWithRowLock(
      tx
        .select()
        .from(providerVerifications)
        .where(eq(providerVerifications.id, params.verificationId))
        .limit(1)
    );

    if (!verification) {
      throw new AdminAuthError(
        "VERIFICATION_NOT_FOUND",
        "Provider verification record not found.",
        404
      );
    }

    const [provider] = await executeWithRowLock(
      tx
        .select()
        .from(providers)
        .where(eq(providers.id, verification.providerId))
        .limit(1)
    );

    if (!provider) {
      throw new AdminAuthError(
        "PROVIDER_NOT_FOUND",
        "Associated provider not found.",
        404
      );
    }

    // Prevent self-approval if an admin owns the provider record
    if (provider.ownerUserId === params.admin.id) {
      throw new AdminAuthError(
        "SELF_APPROVAL_FORBIDDEN",
        "A provider owner cannot self-approve their own verification.",
        403
      );
    }

    if (
      verification.status !== "PENDING" &&
      verification.status !== "UNDER_REVIEW"
    ) {
      throw new AdminAuthError(
        "VERIFICATION_STATE_CONFLICT",
        `Cannot approve provider verification from current state '${verification.status}'.`,
        409
      );
    }

    const providerDocs = await tx
      .select()
      .from(verificationDocuments)
      .where(eq(verificationDocuments.providerId, provider.id));

    const eligibility = evaluateProviderApprovalEligibility({
      provider,
      verification,
      providerDocuments: providerDocs,
      submittedChecklist: params.checklistState,
      enforceSubmittedChecklist: true,
      now,
    });

    if (!eligibility.eligible) {
      throw new AdminAuthError(
        "PROVIDER_APPROVAL_REQUIREMENTS_INCOMPLETE",
        `Provider cannot be approved until all verification requirements are satisfied: ${eligibility.blockingReasons.join(" ")}`,
        400
      );
    }

    // Atomic conditional update to prevent concurrent contradictory decisions
    const updatedVerifications = await tx
      .update(providerVerifications)
      .set({
        status: "APPROVED",
        reviewerId: params.admin.id,
        reviewedAt: now,
        reviewComments: trimmedComments,
        rejectionReason: null,
        requestedDocuments: [],
        checklistState: eligibility.effectiveChecklist,
        expiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(providerVerifications.id, verification.id),
          eq(providerVerifications.status, verification.status)
        )
      )
      .returning({ id: providerVerifications.id });

    if (updatedVerifications.length === 0) {
      throw new AdminAuthError(
        "VERIFICATION_CONFLICT",
        "Concurrent verification decision detected. Please refresh and review the current state.",
        409
      );
    }

    // Update ONLY the provider organization profile.
    // Never bulk-approve associated daycare centres, caregivers, or verification documents.
    await tx
      .update(providers)
      .set({
        verificationStatus: "APPROVED",
        isPublished: true,
        updatedAt: now,
      })
      .where(eq(providers.id, provider.id));

    await appendVerificationReviewHistory(tx, {
      subjectType: "PROVIDER",
      subjectId: provider.id,
      verificationId: verification.id,
      previousStatus: verification.status,
      newStatus: "APPROVED",
      decision: "APPROVED",
      reviewerId: params.admin.id,
      reviewerEmail: params.admin.email,
      reviewComments: trimmedComments,
      evidenceSnapshot: {
        verifiedDocumentsCount: eligibility.verifiedDocumentsCount,
        checklistState: eligibility.effectiveChecklist,
      },
      createdAt: now,
    });

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: "PROVIDER_VERIFICATION_APPROVED",
        entityType: "PROVIDER_VERIFICATION",
        entityId: verification.id,
        summary: `Approved organization verification for ${provider.organizationName} (independent of centres and documents). Comments: ${trimmedComments}`,
        previousState: {
          status: verification.status,
          isPublished: provider.isPublished,
        },
        newState: {
          status: "APPROVED",
          isPublished: true,
          verifiedDocumentsCount: eligibility.verifiedDocumentsCount,
          checklistState: eligibility.effectiveChecklist,
          expiresAt: expiresAt.toISOString(),
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );

    return { verification, provider, eligibility };
  });

  return {
    verificationId: txResult.verification.id,
    providerId: txResult.provider.id,
    status: "APPROVED" as const,
    expiresAt: expiresAt.toISOString(),
    reviewedBy: params.admin.email,
    reviewedAt: now.toISOString(),
  };
}

export async function rejectProviderVerification(params: {
  verificationId: string;
  rejectionReason: string;
  reviewComments?: string;
  suspendProvider?: boolean;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const now = new Date();
  const nextStatus: VerificationStatus = params.suspendProvider
    ? "SUSPENDED"
    : "REJECTED";

  const txResult = await db.transaction(async (tx) => {
    const [verification] = await executeWithRowLock(
      tx
        .select()
        .from(providerVerifications)
        .where(eq(providerVerifications.id, params.verificationId))
        .limit(1)
    );

    if (!verification) {
      throw new AdminAuthError(
        "VERIFICATION_NOT_FOUND",
        "Provider verification record not found.",
        404
      );
    }

    const [provider] = await executeWithRowLock(
      tx
        .select()
        .from(providers)
        .where(eq(providers.id, verification.providerId))
        .limit(1)
    );

    if (!provider) {
      throw new AdminAuthError(
        "PROVIDER_NOT_FOUND",
        "Associated provider not found.",
        404
      );
    }

    if (provider.ownerUserId === params.admin.id) {
      throw new AdminAuthError(
        "SELF_APPROVAL_FORBIDDEN",
        "A provider owner cannot review their own verification.",
        403
      );
    }

    if (
      !params.suspendProvider &&
      verification.status !== "PENDING" &&
      verification.status !== "UNDER_REVIEW"
    ) {
      throw new AdminAuthError(
        "VERIFICATION_STATE_CONFLICT",
        `Cannot reject provider verification from current state '${verification.status}'.`,
        409
      );
    }

    const updatedVerifications = await tx
      .update(providerVerifications)
      .set({
        status: nextStatus,
        reviewerId: params.admin.id,
        reviewedAt: now,
        rejectionReason: params.rejectionReason,
        reviewComments: params.reviewComments ?? params.rejectionReason,
        updatedAt: now,
      })
      .where(
        and(
          eq(providerVerifications.id, verification.id),
          eq(providerVerifications.status, verification.status)
        )
      )
      .returning({ id: providerVerifications.id });

    if (updatedVerifications.length === 0) {
      throw new AdminAuthError(
        "VERIFICATION_CONFLICT",
        "Concurrent verification decision detected. Please refresh and review the current state.",
        409
      );
    }

    await tx
      .update(providers)
      .set({
        verificationStatus: nextStatus,
        isPublished: false,
        updatedAt: now,
      })
      .where(eq(providers.id, provider.id));

    if (params.suspendProvider) {
      await tx
        .update(centers)
        .set({
          listingStatus: "SUSPENDED",
          suspendedReason: `Provider suspended: ${params.rejectionReason}`,
          updatedAt: now,
        })
        .where(eq(centers.providerId, provider.id));
    } else {
      await tx
        .update(centers)
        .set({
          listingStatus: "INACTIVE",
          suspendedReason: `Provider verification rejected: ${params.rejectionReason}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(centers.providerId, provider.id),
            eq(centers.listingStatus, "ACTIVE")
          )
        );
    }

    await appendVerificationReviewHistory(tx, {
      subjectType: "PROVIDER",
      subjectId: provider.id,
      verificationId: verification.id,
      previousStatus: verification.status,
      newStatus: nextStatus,
      decision: nextStatus,
      reviewerId: params.admin.id,
      reviewerEmail: params.admin.email,
      reviewComments: params.reviewComments ?? params.rejectionReason,
      rejectionReason: params.rejectionReason,
      createdAt: now,
    });

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: params.suspendProvider
          ? "PROVIDER_VERIFICATION_SUSPENDED"
          : "PROVIDER_VERIFICATION_REJECTED",
        entityType: "PROVIDER_VERIFICATION",
        entityId: verification.id,
        summary: `${nextStatus} verification for ${provider.organizationName}. Reason: ${params.rejectionReason}`,
        previousState: {
          status: verification.status,
          isPublished: provider.isPublished,
        },
        newState: {
          status: nextStatus,
          isPublished: false,
          rejectionReason: params.rejectionReason,
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );

    return { verification, provider };
  });

  return {
    verificationId: txResult.verification.id,
    providerId: txResult.provider.id,
    status: nextStatus,
    rejectionReason: params.rejectionReason,
    reviewedBy: params.admin.email,
    reviewedAt: now.toISOString(),
  };
}

export async function requestProviderDocuments(params: {
  verificationId: string;
  requestedDocuments: string[];
  reviewComments: string;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const now = new Date();

  const txResult = await db.transaction(async (tx) => {
    const [verification] = await executeWithRowLock(
      tx
        .select()
        .from(providerVerifications)
        .where(eq(providerVerifications.id, params.verificationId))
        .limit(1)
    );

    if (!verification) {
      throw new AdminAuthError(
        "VERIFICATION_NOT_FOUND",
        "Provider verification record not found.",
        404
      );
    }

    const [provider] = await executeWithRowLock(
      tx
        .select()
        .from(providers)
        .where(eq(providers.id, verification.providerId))
        .limit(1)
    );

    if (!provider) {
      throw new AdminAuthError(
        "PROVIDER_NOT_FOUND",
        "Associated provider not found.",
        404
      );
    }

    await tx
      .update(providerVerifications)
      .set({
        status: "UNDER_REVIEW",
        reviewerId: params.admin.id,
        reviewedAt: now,
        requestedDocuments: params.requestedDocuments,
        reviewComments: params.reviewComments,
        updatedAt: now,
      })
      .where(eq(providerVerifications.id, verification.id));

    await tx
      .update(providers)
      .set({
        verificationStatus: "UNDER_REVIEW",
        isPublished: false,
        updatedAt: now,
      })
      .where(eq(providers.id, provider.id));

    await appendVerificationReviewHistory(tx, {
      subjectType: "PROVIDER",
      subjectId: provider.id,
      verificationId: verification.id,
      previousStatus: verification.status,
      newStatus: "UNDER_REVIEW",
      decision: "DOCUMENTS_REQUESTED",
      reviewerId: params.admin.id,
      reviewerEmail: params.admin.email,
      reviewComments: params.reviewComments,
      evidenceSnapshot: { requestedDocuments: params.requestedDocuments },
      createdAt: now,
    });

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: "PROVIDER_DOCUMENTS_REQUESTED",
        entityType: "PROVIDER_VERIFICATION",
        entityId: verification.id,
        summary: `Requested additional documents (${params.requestedDocuments.join(", ")}) from ${provider.organizationName}`,
        previousState: { status: verification.status },
        newState: {
          status: "UNDER_REVIEW",
          requestedDocuments: params.requestedDocuments,
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );

    return { verification, provider };
  });

  return {
    verificationId: txResult.verification.id,
    providerId: txResult.provider.id,
    status: "UNDER_REVIEW" as const,
    requestedDocuments: params.requestedDocuments,
    reviewComments: params.reviewComments,
    reviewedBy: params.admin.email,
    reviewedAt: now.toISOString(),
  };
}

// ==========================================
// 3. Daycare Centre Management & Independent Verification
// ==========================================

export function evaluateCenterApprovalEligibility(params: {
  center: {
    id: string;
    providerId: string;
    name: string;
    address: string;
    city: string;
    state: string;
    postalCode: string;
    phone: string;
    email: string;
    approvedCapacity: number;
    ageGroupsSupported: string[] | null;
    operatingHours: Record<string, unknown> | null;
    verificationStatus: string;
    listingStatus: string;
    verificationExpiresAt?: Date | null;
  };
  provider:
    | {
        id: string;
        ownerUserId: string;
        organizationName: string;
        verificationStatus: string;
        subscriptionActive: boolean;
      }
    | null
    | undefined;
  centerDocuments: Array<{
    id: string;
    providerId: string;
    centerId: string | null;
    caregiverId?: string | null;
    documentCategory?: string | null;
    documentType: string;
    documentTitle: string;
    status: string;
    expiresAt: Date | null;
    malwareScanStatus?: string | null;
    malwareScannedAt?: Date | null;
    malwareScanProvider?: string | null;
    quarantinedAt?: Date | null;
  }>;
  centerCaregivers: Array<{
    id: string;
    fullName: string;
    isActive: boolean;
    backgroundCheckStatus: string;
    verificationExpiresAt?: Date | null;
  }>;
  requestedDocuments?: string[] | null;
  submittedChecklist?: Record<string, boolean>;
  existingChecklist?: Record<string, boolean> | null;
  enforceSubmittedChecklist?: boolean;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const blockingReasons: string[] = [];

  // Rule 1: Provider must be approved and eligible
  if (!params.provider) {
    blockingReasons.push("Associated provider organization record not found.");
  } else {
    if (params.provider.verificationStatus !== "APPROVED") {
      blockingReasons.push(
        `Parent provider '${params.provider.organizationName}' must be APPROVED (current status: ${params.provider.verificationStatus}).`
      );
    }
    if (!params.provider.subscriptionActive) {
      blockingReasons.push(
        `Parent provider '${params.provider.organizationName}' does not have an active operational subscription.`
      );
    }
  }

  // Rule 4: Required operating information must be complete
  if (
    !params.center.name?.trim() ||
    !params.center.address?.trim() ||
    !params.center.city?.trim() ||
    !params.center.state?.trim() ||
    !params.center.postalCode?.trim() ||
    !params.center.phone?.trim() ||
    !params.center.email?.trim()
  ) {
    blockingReasons.push(
      "Centre physical location and contact details are incomplete."
    );
  }

  if (!(params.center.approvedCapacity > 0)) {
    blockingReasons.push(
      "Declared approved capacity must be greater than zero."
    );
  }

  const ageGroups = params.center.ageGroupsSupported ?? [];
  if (!Array.isArray(ageGroups) || ageGroups.length === 0) {
    blockingReasons.push("At least one supported age group must be declared.");
  }

  const opHours = params.center.operatingHours ?? {};
  if (typeof opHours !== "object" || Object.keys(opHours).length === 0) {
    blockingReasons.push(
      "Declared operating hours schedule must be configured."
    );
  }

  // Rule 3: Centre documents must be strictly scoped to this centre, malware-scanned, verified, and current
  const scopedCenterDocs = params.centerDocuments.filter((d) =>
    isCenterScopedDocument(d, params.center.id, params.center.providerId)
  );

  if (scopedCenterDocs.length === 0) {
    blockingReasons.push(
      "At least one facility/centre-scoped verification document must be submitted for this daycare centre."
    );
  } else {
    const rejectedCenterDocs = scopedCenterDocs.filter(
      (d) => d.status === "REJECTED"
    );
    if (rejectedCenterDocs.length > 0) {
      blockingReasons.push(
        `Rejected centre document(s) must be replaced: ${rejectedCenterDocs.map((d) => d.documentTitle).join(", ")}.`
      );
    }

    const expiredCenterDocs = scopedCenterDocs.filter(
      (d) =>
        d.status === "EXPIRED" || (d.expiresAt !== null && d.expiresAt <= now)
    );
    if (expiredCenterDocs.length > 0) {
      blockingReasons.push(
        `Expired centre document(s) must be renewed: ${expiredCenterDocs.map((d) => d.documentTitle).join(", ")}.`
      );
    }

    const unscannedOrInfectedDocs = scopedCenterDocs.filter(
      (d) =>
        Boolean(d.quarantinedAt) ||
        d.malwareScanStatus !== "CLEAN" ||
        !d.malwareScannedAt ||
        !d.malwareScanProvider
    );
    if (unscannedOrInfectedDocs.length > 0) {
      blockingReasons.push(
        `Centre document(s) lack trusted CLEAN malware scan completion: ${unscannedOrInfectedDocs.map((d) => `${d.documentTitle} (${d.malwareScanStatus ?? "PENDING"})`).join(", ")}.`
      );
    }

    const unverifiedCenterDocs = scopedCenterDocs.filter(
      (d) =>
        d.status !== "VERIFIED" &&
        d.status !== "REJECTED" &&
        d.status !== "EXPIRED"
    );
    if (unverifiedCenterDocs.length > 0) {
      blockingReasons.push(
        `All submitted centre documents must be individually VERIFIED (${unverifiedCenterDocs.length} unverified).`
      );
    }
  }

  const verifiedCenterDocs = scopedCenterDocs.filter((d) =>
    isDocumentCurrentlyValid(d, now)
  );
  if (scopedCenterDocs.length > 0 && verifiedCenterDocs.length === 0) {
    blockingReasons.push(
      "No valid, malware-clean, non-expired VERIFIED centre documents are available."
    );
  }

  for (const reqDoc of params.requestedDocuments ?? []) {
    const satisfied = scopedCenterDocs.some(
      (d) =>
        d.documentType.toUpperCase() === reqDoc.toUpperCase() &&
        isDocumentCurrentlyValid(d, now)
    );
    if (!satisfied) {
      blockingReasons.push(
        `Requested centre document '${reqDoc}' has not been uploaded and verified.`
      );
    }
  }

  // Rule 5: Applicable caregiver and staffing requirements must be satisfied
  const eligibleCaregivers = params.centerCaregivers.filter((cg) =>
    isCaregiverEligibleForStaffing(cg, now)
  );
  if (eligibleCaregivers.length === 0) {
    blockingReasons.push(
      "At least one active, non-expired VERIFIED caregiver must be assigned to this centre."
    );
  }

  const submitted = params.submittedChecklist ?? {};
  const effectiveChecklist: Record<string, boolean> =
    params.enforceSubmittedChecklist
      ? { ...submitted }
      : {
          ...(params.existingChecklist ?? {}),
          ...submitted,
        };

  if (params.enforceSubmittedChecklist) {
    for (const requiredKey of CENTER_REQUIRED_CHECKLIST_KEYS) {
      if (submitted[requiredKey] !== true) {
        blockingReasons.push(
          `Mandatory centre checklist item '${requiredKey}' must be reviewed and confirmed (true).`
        );
      }
    }
  } else {
    for (const [key, val] of Object.entries(effectiveChecklist)) {
      if (val === false) {
        blockingReasons.push(
          `Centre checklist item '${key}' is marked incomplete (false).`
        );
      }
    }
  }

  return {
    eligible: blockingReasons.length === 0,
    blockingReasons,
    verifiedDocumentsCount: verifiedCenterDocs.length,
    totalCenterDocumentsCount: scopedCenterDocs.length,
    eligibleCaregiversCount: eligibleCaregivers.length,
    totalCaregiversCount: params.centerCaregivers.length,
    effectiveChecklist,
  };
}

export async function listAdminCenters(filters: {
  search?: string;
  listingStatus?: string;
  verificationStatus?: string;
  city?: string;
}) {
  const [allCenters, allProviders, allCaregivers, allIncidents, allDocs] =
    await Promise.all([
      db.select().from(centers).orderBy(desc(centers.createdAt)),
      db.select().from(providers),
      db.select().from(caregivers),
      db.select().from(safetyIncidents),
      db.select().from(verificationDocuments),
    ]);

  const providerMap = new Map(allProviders.map((p) => [p.id, p]));
  const search = (filters.search || "").trim().toLowerCase();
  const now = new Date();

  return allCenters
    .filter((c) => {
      if (
        filters.listingStatus &&
        filters.listingStatus !== "ALL" &&
        c.listingStatus !== filters.listingStatus
      ) {
        return false;
      }
      if (
        filters.verificationStatus &&
        filters.verificationStatus !== "ALL" &&
        c.verificationStatus !== filters.verificationStatus
      ) {
        return false;
      }
      if (
        filters.city &&
        filters.city !== "ALL" &&
        c.city.toLowerCase() !== filters.city.toLowerCase()
      ) {
        return false;
      }
      if (
        search &&
        !c.name.toLowerCase().includes(search) &&
        !c.city.toLowerCase().includes(search) &&
        !c.address.toLowerCase().includes(search)
      ) {
        return false;
      }
      return true;
    })
    .map((c) => {
      const prov = providerMap.get(c.providerId);
      const centerCaregivers = allCaregivers.filter(
        (cg) => cg.centerId === c.id
      );
      const centerDocs = allDocs.filter((d) => d.centerId === c.id);
      const centerIncidents = allIncidents.filter(
        (inc) => inc.centerId === c.id
      );

      const eligibility = evaluateCenterApprovalEligibility({
        center: c,
        provider: prov,
        centerDocuments: centerDocs,
        centerCaregivers,
        now,
      });

      return {
        id: c.id,
        providerId: c.providerId,
        providerName: prov?.organizationName ?? "Unknown Provider",
        providerVerificationStatus: prov?.verificationStatus ?? "PENDING",
        name: c.name,
        slug: c.slug,
        description: c.description,
        address: c.address,
        city: c.city,
        state: c.state,
        postalCode: c.postalCode,
        phone: c.phone,
        email: c.email,
        ageGroupsSupported: c.ageGroupsSupported,
        operatingHours: c.operatingHours,
        is24x7: c.is24x7,
        approvedCapacity: c.approvedCapacity,
        currentOccupancy: c.currentOccupancy,
        hourlyRate: c.hourlyRate,
        dailyRate: c.dailyRate,
        verificationStatus: c.verificationStatus,
        listingStatus: c.listingStatus,
        suspendedReason: c.suspendedReason,
        reviewComments: c.reviewComments ?? null,
        rejectionReason: c.rejectionReason ?? null,
        rating: c.rating ?? null,
        caregiversCount: eligibility.eligibleCaregiversCount,
        totalCaregiversCount: centerCaregivers.length,
        verifiedDocumentsCount: eligibility.verifiedDocumentsCount,
        totalDocumentsCount: centerDocs.length,
        approvalEligibility: {
          eligible: eligibility.eligible,
          blockingReasons: eligibility.blockingReasons,
        },
        openIncidentsCount: centerIncidents.filter(
          (i) => i.status !== "RESOLVED" && i.status !== "CLOSED"
        ).length,
        createdAt: c.createdAt.toISOString(),
      };
    });
}

export async function getAdminCenterById(centerId: string) {
  const [center] = await db
    .select()
    .from(centers)
    .where(eq(centers.id, centerId))
    .limit(1);

  if (!center) {
    throw new AdminAuthError(
      "CENTER_NOT_FOUND",
      "Daycare centre not found.",
      404
    );
  }

  const [
    providerRows,
    centerCaregivers,
    rules,
    centerIncidents,
    centerBookings,
    centerDocs,
    reviewHistoryRows,
  ] = await Promise.all([
    db
      .select()
      .from(providers)
      .where(eq(providers.id, center.providerId))
      .limit(1),
    db.select().from(caregivers).where(eq(caregivers.centerId, center.id)),
    db
      .select()
      .from(capacityRules)
      .where(eq(capacityRules.centerId, center.id)),
    db
      .select()
      .from(safetyIncidents)
      .where(eq(safetyIncidents.centerId, center.id))
      .orderBy(desc(safetyIncidents.occurredAt)),
    db
      .select()
      .from(bookings)
      .where(eq(bookings.centerId, center.id))
      .orderBy(desc(bookings.startTime)),
    db
      .select()
      .from(verificationDocuments)
      .where(eq(verificationDocuments.centerId, center.id)),
    safeSelectTable(() =>
      db
        .select()
        .from(verificationReviewHistory)
        .orderBy(desc(verificationReviewHistory.createdAt))
    ),
  ]);

  const provider = providerRows[0] ?? null;
  const now = new Date();
  const eligibility = evaluateCenterApprovalEligibility({
    center,
    provider,
    centerDocuments: centerDocs,
    centerCaregivers,
    now,
  });

  const history = reviewHistoryRows
    .filter((h) => h.subjectType === "CENTER" && h.subjectId === center.id)
    .map((h) => ({
      id: h.id,
      previousStatus: h.previousStatus,
      newStatus: h.newStatus,
      decision: h.decision,
      reviewerEmail: h.reviewerEmail,
      reviewComments: h.reviewComments,
      rejectionReason: h.rejectionReason,
      createdAt: h.createdAt.toISOString(),
    }));

  return {
    ...center,
    rating: center.rating ?? null,
    createdAt: center.createdAt.toISOString(),
    updatedAt: center.updatedAt.toISOString(),
    verifiedAt: center.verifiedAt ? center.verifiedAt.toISOString() : null,
    verificationExpiresAt: center.verificationExpiresAt
      ? center.verificationExpiresAt.toISOString()
      : null,
    approvalEligibility: {
      eligible: eligibility.eligible,
      reasons: eligibility.blockingReasons,
      blockingReasons: eligibility.blockingReasons,
      verifiedDocumentsCount: eligibility.verifiedDocumentsCount,
      eligibleCaregiversCount: eligibility.eligibleCaregiversCount,
    },
    history,
    provider: provider
      ? {
          id: provider.id,
          organizationName: provider.organizationName,
          registrationNumber: provider.registrationNumber,
          verificationStatus: provider.verificationStatus,
        }
      : null,
    documents: centerDocs.map((d) => ({
      id: d.id,
      documentType: d.documentType,
      documentTitle: d.documentTitle,
      mimeType: d.mimeType,
      fileSizeBytes: d.fileSizeBytes,
      status:
        d.expiresAt && d.expiresAt <= now && d.status !== "REJECTED"
          ? "EXPIRED"
          : d.status,
      malwareScanStatus: (d.malwareScanStatus || "PENDING") as MalwareScanStatus,
      malwareScanProvider: d.malwareScanProvider ?? null,
      malwareScannedAt: d.malwareScannedAt
        ? d.malwareScannedAt.toISOString()
        : null,
      quarantinedAt: d.quarantinedAt ? d.quarantinedAt.toISOString() : null,
      expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
      reviewNotes: d.reviewNotes,
      rejectionReason: d.rejectionReason ?? null,
      accessUrl: buildPrivateDocumentAccessDescriptor(d.id),
    })),
    caregivers: centerCaregivers.map((cg) => ({
      id: cg.id,
      fullName: cg.fullName,
      email: cg.email,
      phone: cg.phone,
      roleTitle: cg.roleTitle,
      certifications: cg.certifications,
      backgroundCheckStatus: getEffectiveCaregiverStatus(cg, now),
      yearsExperience: cg.yearsExperience,
      isActive: cg.isActive,
      eligibleForStaffing: isCaregiverEligibleForStaffing(cg, now),
      verifiedAt: cg.verifiedAt ? cg.verifiedAt.toISOString() : null,
      verificationExpiresAt: cg.verificationExpiresAt
        ? cg.verificationExpiresAt.toISOString()
        : null,
      reviewComments: cg.reviewComments ?? null,
      rejectionReason: cg.rejectionReason ?? null,
    })),
    capacityRules: rules.map((r) => ({
      id: r.id,
      ageGroup: r.ageGroup,
      maxChildren: r.maxChildren,
      caregiverRatio: r.caregiverRatio,
      isActive: r.isActive,
    })),
    incidents: centerIncidents.map((inc) => ({
      id: inc.id,
      incidentReference: inc.incidentReference,
      title: inc.title,
      category: inc.category,
      severity: inc.severity,
      status: inc.status,
      occurredAt: inc.occurredAt.toISOString(),
    })),
    activeBookingsCount: centerBookings.filter((b) =>
      ["REQUESTED", "CONFIRMED", "CHECKED_IN"].includes(b.status)
    ).length,
  };
}

export async function updateAdminCenterStatus(params: {
  centerId: string;
  listingStatus: CenterListingStatus;
  reason: string;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const now = new Date();

  return db.transaction(async (tx) => {
    const [center] = await executeWithRowLock(
      tx.select().from(centers).where(eq(centers.id, params.centerId)).limit(1)
    );

    if (!center) {
      throw new AdminAuthError(
        "CENTER_NOT_FOUND",
        "Daycare centre not found.",
        404
      );
    }

    if (params.listingStatus === "ACTIVE") {
      if (center.verificationStatus !== "APPROVED") {
        throw new AdminAuthError(
          "CENTER_UNVERIFIED",
          "Cannot publicly activate a centre listing until its independent centre verification status is APPROVED.",
          400
        );
      }

      if (
        center.verificationExpiresAt &&
        center.verificationExpiresAt <= now
      ) {
        throw new AdminAuthError(
          "CENTER_VERIFICATION_EXPIRED",
          "Cannot activate centre listing: centre verification has expired.",
          400
        );
      }

      const [providerRows, centerDocs, centerCaregivers] = await Promise.all([
        tx
          .select()
          .from(providers)
          .where(eq(providers.id, center.providerId))
          .limit(1),
        tx
          .select()
          .from(verificationDocuments)
          .where(eq(verificationDocuments.centerId, center.id)),
        tx.select().from(caregivers).where(eq(caregivers.centerId, center.id)),
      ]);

      const eligibility = evaluateCenterApprovalEligibility({
        center,
        provider: providerRows[0],
        centerDocuments: centerDocs,
        centerCaregivers,
        now,
      });

      if (!eligibility.eligible) {
        throw new AdminAuthError(
          "CENTER_ACTIVATION_ELIGIBILITY_FAILED",
          `Cannot activate centre listing: ${eligibility.blockingReasons.join(" ")}`,
          400
        );
      }
    }

    // Check active bookings so administrative actions never silently corrupt existing bookings
    const existingBookings = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.centerId, center.id));

    const activeBookings = existingBookings.filter((b) =>
      ["CONFIRMED", "CHECKED_IN"].includes(b.status)
    );

    const [updated] = await tx
      .update(centers)
      .set({
        listingStatus: params.listingStatus,
        suspendedReason:
          params.listingStatus === "SUSPENDED" ? params.reason : null,
        updatedAt: now,
      })
      .where(eq(centers.id, center.id))
      .returning();

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: `CENTER_STATUS_${params.listingStatus}`,
        entityType: "CENTER",
        entityId: center.id,
        summary: `Changed listing status of "${center.name}" from ${center.listingStatus} to ${params.listingStatus} (${activeBookings.length} active bookings preserved). Reason: ${params.reason}`,
        previousState: { listingStatus: center.listingStatus },
        newState: {
          listingStatus: params.listingStatus,
          reason: params.reason,
          preservedActiveBookingsCount: activeBookings.length,
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );

    return {
      id: updated.id,
      name: updated.name,
      listingStatus: updated.listingStatus,
      suspendedReason: updated.suspendedReason,
      preservedActiveBookingsCount: activeBookings.length,
      updatedAt: updated.updatedAt.toISOString(),
    };
  });
}

export async function listAdminCenterVerifications(filters: {
  status?: string;
  search?: string;
}) {
  const [
    allCenters,
    allProviders,
    allDocs,
    allCaregivers,
    centerVerifRows,
    historyRows,
  ] = await Promise.all([
    db.select().from(centers).orderBy(desc(centers.createdAt)),
    db.select().from(providers),
    db.select().from(verificationDocuments),
    db.select().from(caregivers),
    safeSelectTable(() =>
      db
        .select()
        .from(centerVerifications)
        .orderBy(desc(centerVerifications.submittedAt))
    ),
    safeSelectTable(() =>
      db
        .select()
        .from(verificationReviewHistory)
        .orderBy(desc(verificationReviewHistory.createdAt))
    ),
  ]);

  const providerMap = new Map(allProviders.map((p) => [p.id, p]));
  const search = (filters.search || "").trim().toLowerCase();
  const now = new Date();

  return allCenters
    .map((c) => {
      const prov = providerMap.get(c.providerId);
      const centerDocs = allDocs.filter((d) =>
        isCenterScopedDocument(d, c.id, c.providerId)
      );
      const centerCaregivers = allCaregivers.filter(
        (cg) => cg.centerId === c.id
      );
      const verifRecord = centerVerifRows.find((cv) => cv.centerId === c.id);

      const effectiveStatus: VerificationStatus =
        c.verificationStatus === "APPROVED" &&
        c.verificationExpiresAt &&
        c.verificationExpiresAt <= now
          ? "EXPIRED"
          : (verifRecord?.status ?? c.verificationStatus);

      const eligibility = evaluateCenterApprovalEligibility({
        center: c,
        provider: prov,
        centerDocuments: centerDocs,
        centerCaregivers,
        requestedDocuments: verifRecord?.requestedDocuments ?? [],
        existingChecklist: verifRecord?.checklistState ?? {},
        now,
      });

      const history = historyRows
        .filter((h) => h.subjectType === "CENTER" && h.subjectId === c.id)
        .map((h) => ({
          id: h.id,
          previousStatus: h.previousStatus,
          newStatus: h.newStatus,
          decision: h.decision,
          reviewerEmail: h.reviewerEmail,
          reviewComments: h.reviewComments,
          rejectionReason: h.rejectionReason,
          createdAt: h.createdAt.toISOString(),
        }));

      return {
        id: verifRecord?.id ?? c.id,
        centerId: c.id,
        providerId: c.providerId,
        providerName: prov?.organizationName ?? "Unknown Provider",
        providerVerificationStatus: prov?.verificationStatus ?? "PENDING",
        centerName: c.name,
        city: c.city,
        state: c.state,
        address: c.address,
        approvedCapacity: c.approvedCapacity,
        is24x7: c.is24x7,
        ageGroupsSupported: c.ageGroupsSupported,
        status: effectiveStatus,
        verificationStatus: effectiveStatus as VerificationStatus,
        listingStatus: c.listingStatus,
        reviewComments:
          verifRecord?.reviewComments ?? c.reviewComments ?? null,
        rejectionReason:
          verifRecord?.rejectionReason ?? c.rejectionReason ?? null,
        requestedDocuments: verifRecord?.requestedDocuments ?? [],
        checklistState: verifRecord?.checklistState ?? {},
        verifiedAt: c.verifiedAt ? c.verifiedAt.toISOString() : null,
        expiresAt: c.verificationExpiresAt
          ? c.verificationExpiresAt.toISOString()
          : verifRecord?.expiresAt
            ? verifRecord.expiresAt.toISOString()
            : null,
        approvalEligibility: {
          eligible: eligibility.eligible,
          reasons: eligibility.blockingReasons,
          blockingReasons: eligibility.blockingReasons,
          verifiedDocumentsCount: eligibility.verifiedDocumentsCount,
          totalCenterDocumentsCount: eligibility.totalCenterDocumentsCount,
          eligibleCaregiversCount: eligibility.eligibleCaregiversCount,
          totalCaregiversCount: eligibility.totalCaregiversCount,
        },
        caregivers: centerCaregivers.map((cg) => ({
          id: cg.id,
          fullName: cg.fullName,
          email: cg.email,
          roleTitle: cg.roleTitle,
          backgroundCheckStatus: getEffectiveCaregiverStatus(cg, now),
          isExpired:
            cg.verificationExpiresAt !== null &&
            cg.verificationExpiresAt <= now,
          isActive: cg.isActive,
          verifiedAt: cg.verifiedAt ? cg.verifiedAt.toISOString() : null,
          verificationExpiresAt: cg.verificationExpiresAt
            ? cg.verificationExpiresAt.toISOString()
            : null,
        })),
        documents: centerDocs.map((d) => ({
          id: d.id,
          documentType: d.documentType,
          documentTitle: d.documentTitle,
          malwareScanStatus: (d.malwareScanStatus || "PENDING") as MalwareScanStatus,
          malwareScanProvider: d.malwareScanProvider ?? null,
          malwareScannedAt: d.malwareScannedAt
            ? d.malwareScannedAt.toISOString()
            : null,
          quarantinedAt: d.quarantinedAt ? d.quarantinedAt.toISOString() : null,
          status:
            d.expiresAt && d.expiresAt <= now && d.status !== "REJECTED"
              ? "EXPIRED"
              : d.status,
          expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
        })),
        history,
        reviewHistory: history,
      };
    })
    .filter((item) => {
      if (
        filters.status &&
        filters.status !== "ALL" &&
        item.status !== filters.status
      ) {
        return false;
      }
      if (
        search &&
        !item.centerName.toLowerCase().includes(search) &&
        !item.providerName.toLowerCase().includes(search) &&
        !item.city.toLowerCase().includes(search)
      ) {
        return false;
      }
      return true;
    });
}

export async function getAdminCenterVerificationById(idOrCenterId: string) {
  const items = await listAdminCenterVerifications({});
  const match = items.find(
    (item) => item.id === idOrCenterId || item.centerId === idOrCenterId
  );
  if (!match) {
    throw new AdminAuthError(
      "CENTER_VERIFICATION_NOT_FOUND",
      "Daycare centre verification record not found.",
      404
    );
  }
  return match;
}

export async function approveCenterVerification(params: {
  idOrCenterId: string;
  reviewComments: string;
  checklistState?: Record<string, boolean>;
  safetyComplianceNotes?: string;
  activateListing?: boolean;
  expiresAt?: string;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const trimmedComments = (params.reviewComments || "").trim();
  if (trimmedComments.length < 3) {
    throw new AdminAuthError(
      "REVIEW_COMMENTS_REQUIRED",
      "Review comments of at least 3 characters are required when approving a daycare centre.",
      400
    );
  }

  const now = new Date();
  const expiresAt = params.expiresAt
    ? new Date(params.expiresAt)
    : new Date(now.getTime() + 365 * 86_400_000);

  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
    throw new AdminAuthError(
      "INVALID_EXPIRATION_DATE",
      "Daycare centre verification expiration date must be a valid future timestamp.",
      400
    );
  }

  const targetListingStatus: CenterListingStatus =
    params.activateListing === false ? "INACTIVE" : "ACTIVE";

  const txResult = await db.transaction(async (tx) => {
    const existingVerifs = await safeSelectTable(() =>
      tx
        .select()
        .from(centerVerifications)
        .where(eq(centerVerifications.id, params.idOrCenterId))
    );
    const resolvedCenterId =
      existingVerifs[0]?.centerId ?? params.idOrCenterId;

    const [center] = await executeWithRowLock(
      tx.select().from(centers).where(eq(centers.id, resolvedCenterId)).limit(1)
    );

    if (!center) {
      throw new AdminAuthError(
        "CENTER_NOT_FOUND",
        "Daycare centre not found.",
        404
      );
    }

    const [provider] = await tx
      .select()
      .from(providers)
      .where(eq(providers.id, center.providerId))
      .limit(1);

    if (!provider) {
      throw new AdminAuthError(
        "PROVIDER_NOT_FOUND",
        "Parent provider organization not found.",
        404
      );
    }

    if (provider.ownerUserId === params.admin.id) {
      throw new AdminAuthError(
        "SELF_APPROVAL_FORBIDDEN",
        "A provider owner cannot self-approve their own daycare centre.",
        403
      );
    }

    if (center.verificationStatus === "APPROVED" && center.listingStatus === "ACTIVE") {
      throw new AdminAuthError(
        "CENTER_ALREADY_APPROVED",
        "This daycare centre is already verified and active.",
        409
      );
    }

    if (
      center.listingStatus === "SUSPENDED" ||
      center.verificationStatus === "SUSPENDED"
    ) {
      throw new AdminAuthError(
        "CENTER_SUSPENDED",
        "Suspended daycare centres cannot be approved or activated while under compliance hold.",
        400
      );
    }

    const [centerDocs, centerCaregivers, centerVerifByCenter] =
      await Promise.all([
        tx
          .select()
          .from(verificationDocuments)
          .where(eq(verificationDocuments.centerId, center.id)),
        tx.select().from(caregivers).where(eq(caregivers.centerId, center.id)),
        safeSelectTable(() =>
          tx
            .select()
            .from(centerVerifications)
            .where(eq(centerVerifications.centerId, center.id))
        ),
      ]);

    const verifRecord = existingVerifs[0] ?? centerVerifByCenter[0] ?? null;

    const eligibility = evaluateCenterApprovalEligibility({
      center,
      provider,
      centerDocuments: centerDocs,
      centerCaregivers,
      requestedDocuments: verifRecord?.requestedDocuments ?? [],
      existingChecklist: verifRecord?.checklistState ?? {},
      submittedChecklist: params.checklistState,
      enforceSubmittedChecklist: true,
      now,
    });

    if (!eligibility.eligible) {
      throw new AdminAuthError(
        "CENTER_APPROVAL_REQUIREMENTS_INCOMPLETE",
        `Daycare centre cannot be approved: ${eligibility.blockingReasons.join(" ")}`,
        400
      );
    }

    // Conditional update on centers to prevent concurrent conflicting decisions
    const updatedCenters = await tx
      .update(centers)
      .set({
        verificationStatus: "APPROVED",
        listingStatus: targetListingStatus,
        verifiedBy: params.admin.id,
        verifiedAt: now,
        verificationExpiresAt: expiresAt,
        reviewComments: trimmedComments,
        rejectionReason: null,
        suspendedReason: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(centers.id, center.id),
          eq(centers.verificationStatus, center.verificationStatus)
        )
      )
      .returning();

    if (updatedCenters.length === 0) {
      throw new AdminAuthError(
        "VERIFICATION_CONFLICT",
        "Concurrent centre verification decision detected.",
        409
      );
    }

    let verifId = verifRecord?.id ?? center.id;
    if (verifRecord) {
      await tx
        .update(centerVerifications)
        .set({
          status: "APPROVED",
          reviewerId: params.admin.id,
          reviewedAt: now,
          reviewComments: trimmedComments,
          rejectionReason: null,
          requestedDocuments: [],
          checklistState: eligibility.effectiveChecklist,
          safetyComplianceNotes: params.safetyComplianceNotes ?? null,
          expiresAt,
          updatedAt: now,
        })
        .where(eq(centerVerifications.id, verifRecord.id));
    } else {
      const [insertedVerif] = await tx
        .insert(centerVerifications)
        .values({
          centerId: center.id,
          providerId: provider.id,
          status: "APPROVED",
          reviewerId: params.admin.id,
          submittedAt: center.createdAt,
          reviewedAt: now,
          reviewComments: trimmedComments,
          checklistState: eligibility.effectiveChecklist,
          safetyComplianceNotes: params.safetyComplianceNotes ?? null,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: centerVerifications.id });
      if (insertedVerif) {
        verifId = insertedVerif.id;
      }
    }

    await appendVerificationReviewHistory(tx, {
      subjectType: "CENTER",
      subjectId: center.id,
      verificationId: verifId,
      previousStatus: center.verificationStatus,
      newStatus: "APPROVED",
      decision: "APPROVED",
      reviewerId: params.admin.id,
      reviewerEmail: params.admin.email,
      reviewComments: trimmedComments,
      evidenceSnapshot: {
        verifiedDocumentsCount: eligibility.verifiedDocumentsCount,
        eligibleCaregiversCount: eligibility.eligibleCaregiversCount,
        listingStatus: targetListingStatus,
        expiresAt: expiresAt.toISOString(),
      },
      createdAt: now,
    });

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: "CENTER_VERIFICATION_APPROVED",
        entityType: "CENTER_VERIFICATION",
        entityId: center.id,
        summary: `Approved daycare centre "${center.name}" (${provider.organizationName}) and set listingStatus to ${targetListingStatus}. Comments: ${trimmedComments}`,
        previousState: {
          verificationStatus: center.verificationStatus,
          listingStatus: center.listingStatus,
        },
        newState: {
          verificationStatus: "APPROVED",
          listingStatus: targetListingStatus,
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );

    return { center, provider, verifId, eligibility };
  });

  return {
    verificationId: txResult.verifId,
    centerId: txResult.center.id,
    status: "APPROVED" as const,
    listingStatus: targetListingStatus,
    expiresAt: expiresAt.toISOString(),
    reviewedBy: params.admin.email,
    reviewedAt: now.toISOString(),
  };
}

export async function rejectCenterVerification(params: {
  idOrCenterId: string;
  rejectionReason: string;
  reviewComments?: string;
  suspendCenter?: boolean;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const now = new Date();
  const nextStatus: VerificationStatus = params.suspendCenter
    ? "SUSPENDED"
    : "REJECTED";
  const nextListingStatus: CenterListingStatus = params.suspendCenter
    ? "SUSPENDED"
    : "INACTIVE";

  const txResult = await db.transaction(async (tx) => {
    const existingVerifs = await safeSelectTable(() =>
      tx
        .select()
        .from(centerVerifications)
        .where(eq(centerVerifications.id, params.idOrCenterId))
    );
    const resolvedCenterId =
      existingVerifs[0]?.centerId ?? params.idOrCenterId;

    const [center] = await executeWithRowLock(
      tx.select().from(centers).where(eq(centers.id, resolvedCenterId)).limit(1)
    );

    if (!center) {
      throw new AdminAuthError(
        "CENTER_NOT_FOUND",
        "Daycare centre not found.",
        404
      );
    }

    const [provider] = await tx
      .select()
      .from(providers)
      .where(eq(providers.id, center.providerId))
      .limit(1);

    if (provider && provider.ownerUserId === params.admin.id) {
      throw new AdminAuthError(
        "SELF_APPROVAL_FORBIDDEN",
        "A provider owner cannot review their own daycare centre.",
        403
      );
    }

    const updatedCenters = await tx
      .update(centers)
      .set({
        verificationStatus: nextStatus,
        listingStatus: nextListingStatus,
        verifiedBy: params.admin.id,
        verifiedAt: now,
        rejectionReason: params.rejectionReason,
        reviewComments: params.reviewComments ?? params.rejectionReason,
        suspendedReason: params.rejectionReason,
        updatedAt: now,
      })
      .where(
        and(
          eq(centers.id, center.id),
          eq(centers.verificationStatus, center.verificationStatus)
        )
      )
      .returning();

    if (updatedCenters.length === 0) {
      throw new AdminAuthError(
        "VERIFICATION_CONFLICT",
        "Concurrent centre verification decision detected.",
        409
      );
    }

    const byCenter = await safeSelectTable(() =>
      tx
        .select()
        .from(centerVerifications)
        .where(eq(centerVerifications.centerId, center.id))
    );
    const verifRecord = existingVerifs[0] ?? byCenter[0] ?? null;
    let verifId = verifRecord?.id ?? center.id;

    if (verifRecord) {
      await tx
        .update(centerVerifications)
        .set({
          status: nextStatus,
          reviewerId: params.admin.id,
          reviewedAt: now,
          rejectionReason: params.rejectionReason,
          reviewComments: params.reviewComments ?? params.rejectionReason,
          updatedAt: now,
        })
        .where(eq(centerVerifications.id, verifRecord.id));
    } else {
      const [inserted] = await tx
        .insert(centerVerifications)
        .values({
          centerId: center.id,
          providerId: center.providerId,
          status: nextStatus,
          reviewerId: params.admin.id,
          submittedAt: center.createdAt,
          reviewedAt: now,
          rejectionReason: params.rejectionReason,
          reviewComments: params.reviewComments ?? params.rejectionReason,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: centerVerifications.id });
      if (inserted) verifId = inserted.id;
    }

    await appendVerificationReviewHistory(tx, {
      subjectType: "CENTER",
      subjectId: center.id,
      verificationId: verifId,
      previousStatus: center.verificationStatus,
      newStatus: nextStatus,
      decision: nextStatus,
      reviewerId: params.admin.id,
      reviewerEmail: params.admin.email,
      reviewComments: params.reviewComments ?? params.rejectionReason,
      rejectionReason: params.rejectionReason,
      createdAt: now,
    });

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: params.suspendCenter
          ? "CENTER_VERIFICATION_SUSPENDED"
          : "CENTER_VERIFICATION_REJECTED",
        entityType: "CENTER_VERIFICATION",
        entityId: center.id,
        summary: `${nextStatus} daycare centre "${center.name}". Reason: ${params.rejectionReason}`,
        previousState: {
          verificationStatus: center.verificationStatus,
          listingStatus: center.listingStatus,
        },
        newState: {
          verificationStatus: nextStatus,
          listingStatus: nextListingStatus,
          rejectionReason: params.rejectionReason,
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );

    return { center, verifId };
  });

  return {
    verificationId: txResult.verifId,
    centerId: txResult.center.id,
    status: nextStatus,
    listingStatus: nextListingStatus,
    rejectionReason: params.rejectionReason,
    reviewedBy: params.admin.email,
    reviewedAt: now.toISOString(),
  };
}

export async function requestCenterDocuments(params: {
  idOrCenterId: string;
  requestedDocuments: string[];
  reviewComments: string;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const now = new Date();

  const txResult = await db.transaction(async (tx) => {
    const existingVerifs = await safeSelectTable(() =>
      tx
        .select()
        .from(centerVerifications)
        .where(eq(centerVerifications.id, params.idOrCenterId))
    );
    const resolvedCenterId =
      existingVerifs[0]?.centerId ?? params.idOrCenterId;

    const [center] = await executeWithRowLock(
      tx.select().from(centers).where(eq(centers.id, resolvedCenterId)).limit(1)
    );

    if (!center) {
      throw new AdminAuthError(
        "CENTER_NOT_FOUND",
        "Daycare centre not found.",
        404
      );
    }

    await tx
      .update(centers)
      .set({
        verificationStatus: "UNDER_REVIEW",
        listingStatus:
          center.listingStatus === "ACTIVE"
            ? "PENDING_APPROVAL"
            : center.listingStatus,
        reviewComments: params.reviewComments,
        updatedAt: now,
      })
      .where(eq(centers.id, center.id));

    const byCenter = await safeSelectTable(() =>
      tx
        .select()
        .from(centerVerifications)
        .where(eq(centerVerifications.centerId, center.id))
    );
    const verifRecord = existingVerifs[0] ?? byCenter[0] ?? null;
    let verifId = verifRecord?.id ?? center.id;

    if (verifRecord) {
      await tx
        .update(centerVerifications)
        .set({
          status: "UNDER_REVIEW",
          reviewerId: params.admin.id,
          reviewedAt: now,
          requestedDocuments: params.requestedDocuments,
          reviewComments: params.reviewComments,
          updatedAt: now,
        })
        .where(eq(centerVerifications.id, verifRecord.id));
    } else {
      const [inserted] = await tx
        .insert(centerVerifications)
        .values({
          centerId: center.id,
          providerId: center.providerId,
          status: "UNDER_REVIEW",
          reviewerId: params.admin.id,
          submittedAt: center.createdAt,
          reviewedAt: now,
          requestedDocuments: params.requestedDocuments,
          reviewComments: params.reviewComments,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: centerVerifications.id });
      if (inserted) verifId = inserted.id;
    }

    await appendVerificationReviewHistory(tx, {
      subjectType: "CENTER",
      subjectId: center.id,
      verificationId: verifId,
      previousStatus: center.verificationStatus,
      newStatus: "UNDER_REVIEW",
      decision: "DOCUMENTS_REQUESTED",
      reviewerId: params.admin.id,
      reviewerEmail: params.admin.email,
      reviewComments: params.reviewComments,
      evidenceSnapshot: { requestedDocuments: params.requestedDocuments },
      createdAt: now,
    });

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: "CENTER_DOCUMENTS_REQUESTED",
        entityType: "CENTER_VERIFICATION",
        entityId: center.id,
        summary: `Requested additional documents (${params.requestedDocuments.join(", ")}) for centre "${center.name}"`,
        previousState: { verificationStatus: center.verificationStatus },
        newState: {
          verificationStatus: "UNDER_REVIEW",
          requestedDocuments: params.requestedDocuments,
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );

    return { center, verifId };
  });

  return {
    verificationId: txResult.verifId,
    centerId: txResult.center.id,
    status: "UNDER_REVIEW" as const,
    requestedDocuments: params.requestedDocuments,
    reviewComments: params.reviewComments,
    reviewedBy: params.admin.email,
    reviewedAt: now.toISOString(),
  };
}

// ==========================================
// 3B. Caregiver Verification & Document Review
// ==========================================

export async function listAdminCaregiverVerifications(filters: {
  status?: string;
  centerId?: string;
  search?: string;
}) {
  const [
    allCaregivers,
    allCenters,
    allProviders,
    allDocs,
    allUsers,
    cgVerifRows,
    historyRows,
  ] = await Promise.all([
    db.select().from(caregivers).orderBy(desc(caregivers.createdAt)),
    db.select().from(centers),
    db.select().from(providers),
    db.select().from(verificationDocuments),
    db.select().from(users),
    safeSelectTable(() =>
      db
        .select()
        .from(caregiverVerifications)
        .orderBy(desc(caregiverVerifications.submittedAt))
    ),
    safeSelectTable(() =>
      db
        .select()
        .from(verificationReviewHistory)
        .orderBy(desc(verificationReviewHistory.createdAt))
    ),
  ]);

  const centerMap = new Map(allCenters.map((c) => [c.id, c]));
  const providerMap = new Map(allProviders.map((p) => [p.id, p]));
  const userMap = new Map(allUsers.map((u) => [u.id, u]));
  const search = (filters.search || "").trim().toLowerCase();
  const now = new Date();

  return allCaregivers
    .map((cg) => {
      const center = centerMap.get(cg.centerId);
      const prov = center ? providerMap.get(center.providerId) : undefined;
      const verifRecord = cgVerifRows.find((v) => v.caregiverId === cg.id);
      const cgDocs = allDocs.filter(
        (d) =>
          d.caregiverId === cg.id ||
          (Boolean(prov && d.providerId === prov.id) &&
            (verifRecord?.documentReferences ?? []).includes(d.id) &&
            (!d.caregiverId || d.caregiverId === cg.id))
      );
      const effectiveStatus = getEffectiveCaregiverStatus(cg, now);
      const validDocs = cgDocs.filter((d) => isDocumentCurrentlyValid(d, now));
      const reviewer = cg.verifiedBy ? userMap.get(cg.verifiedBy) : null;

      const blockingReasons: string[] = [];
      if (!cg.isActive || effectiveStatus === "SUSPENDED") {
        blockingReasons.push("Caregiver is currently inactive or suspended.");
      }
      if (cgDocs.length === 0) {
        blockingReasons.push(
          "At least one caregiver background screening or credential document must be submitted."
        );
      } else if (validDocs.length === 0) {
        blockingReasons.push(
          "Supporting caregiver screening document(s) must pass malware scan (CLEAN) and be individually VERIFIED and non-expired."
        );
      }

      const history = historyRows
        .filter((h) => h.subjectType === "CAREGIVER" && h.subjectId === cg.id)
        .map((h) => ({
          id: h.id,
          previousStatus: h.previousStatus,
          newStatus: h.newStatus,
          decision: h.decision,
          reviewerEmail: h.reviewerEmail,
          reviewComments: h.reviewComments,
          rejectionReason: h.rejectionReason,
          createdAt: h.createdAt.toISOString(),
        }));

      return {
        id: verifRecord?.id ?? cg.id,
        caregiverId: cg.id,
        centerId: cg.centerId,
        centerName: center?.name ?? "Unknown Centre",
        providerId: prov?.id ?? "",
        providerName: prov?.organizationName ?? "Unknown Provider",
        fullName: cg.fullName,
        email: cg.email,
        phone: cg.phone,
        roleTitle: cg.roleTitle,
        certifications: cg.certifications,
        yearsExperience: cg.yearsExperience,
        isActive: cg.isActive,
        status: effectiveStatus,
        backgroundCheckStatus: effectiveStatus,
        rawBackgroundCheckStatus: cg.backgroundCheckStatus as CaregiverVerificationStatus,
        isExpired:
          cg.verificationExpiresAt !== null && cg.verificationExpiresAt <= now,
        eligibleForStaffing: isCaregiverEligibleForStaffing(cg, now),
        verifiedByEmail: reviewer?.email ?? null,
        verifiedAt: cg.verifiedAt ? cg.verifiedAt.toISOString() : null,
        verificationExpiresAt: cg.verificationExpiresAt
          ? cg.verificationExpiresAt.toISOString()
          : null,
        reviewComments: cg.reviewComments ?? verifRecord?.reviewComments ?? null,
        rejectionReason:
          cg.rejectionReason ?? verifRecord?.rejectionReason ?? null,
        approvalEligibility: {
          eligible: blockingReasons.length === 0,
          reasons: blockingReasons,
          blockingReasons,
          verifiedDocumentsCount: validDocs.length,
          totalDocumentsCount: cgDocs.length,
        },
        documents: cgDocs.map((d) => ({
          id: d.id,
          documentType: d.documentType,
          documentTitle: d.documentTitle,
          malwareScanStatus: (d.malwareScanStatus || "PENDING") as MalwareScanStatus,
          malwareScanProvider: d.malwareScanProvider ?? null,
          malwareScannedAt: d.malwareScannedAt
            ? d.malwareScannedAt.toISOString()
            : null,
          quarantinedAt: d.quarantinedAt ? d.quarantinedAt.toISOString() : null,
          status:
            d.expiresAt && d.expiresAt <= now && d.status !== "REJECTED"
              ? "EXPIRED"
              : d.status,
          expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
        })),
        history,
        reviewHistory: history,
        createdAt: cg.createdAt.toISOString(),
      };
    })
    .filter((item) => {
      if (
        filters.status &&
        filters.status !== "ALL" &&
        item.status !== filters.status
      ) {
        return false;
      }
      if (
        filters.centerId &&
        filters.centerId !== "ALL" &&
        item.centerId !== filters.centerId
      ) {
        return false;
      }
      if (
        search &&
        !item.fullName.toLowerCase().includes(search) &&
        !item.email.toLowerCase().includes(search) &&
        !item.centerName.toLowerCase().includes(search)
      ) {
        return false;
      }
      return true;
    });
}

export async function getAdminCaregiverVerificationById(
  idOrCaregiverId: string
) {
  const items = await listAdminCaregiverVerifications({});
  const match = items.find(
    (item) => item.id === idOrCaregiverId || item.caregiverId === idOrCaregiverId
  );
  if (!match) {
    throw new AdminAuthError(
      "CAREGIVER_NOT_FOUND",
      "Caregiver verification record not found.",
      404
    );
  }
  return match;
}

export async function approveCaregiverVerification(params: {
  idOrCaregiverId: string;
  reviewComments: string;
  checklistState?: Record<string, boolean>;
  expiresAt?: string;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const trimmedComments = (params.reviewComments || "").trim();
  if (trimmedComments.length < 3) {
    throw new AdminAuthError(
      "REVIEW_COMMENTS_REQUIRED",
      "Review comments of at least 3 characters are required when approving caregiver screening.",
      400
    );
  }

  const submittedChecklist = params.checklistState ?? {};
  for (const requiredKey of CAREGIVER_REQUIRED_CHECKLIST_KEYS) {
    if (submittedChecklist[requiredKey] !== true) {
      throw new AdminAuthError(
        "CAREGIVER_CHECKLIST_INCOMPLETE",
        `Mandatory caregiver screening checklist item '${requiredKey}' must be reviewed and confirmed (true).`,
        400
      );
    }
  }

  const now = new Date();
  const expiresAt = params.expiresAt
    ? new Date(params.expiresAt)
    : new Date(now.getTime() + 365 * 86_400_000);

  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
    throw new AdminAuthError(
      "INVALID_EXPIRATION_DATE",
      "Caregiver verification expiration date must be in the future.",
      400
    );
  }

  const txResult = await db.transaction(async (tx) => {
    const existingVerifs = await safeSelectTable(() =>
      tx
        .select()
        .from(caregiverVerifications)
        .where(eq(caregiverVerifications.id, params.idOrCaregiverId))
    );
    const resolvedCaregiverId =
      existingVerifs[0]?.caregiverId ?? params.idOrCaregiverId;

    const [caregiver] = await executeWithRowLock(
      tx
        .select()
        .from(caregivers)
        .where(eq(caregivers.id, resolvedCaregiverId))
        .limit(1)
    );

    if (!caregiver) {
      throw new AdminAuthError(
        "CAREGIVER_NOT_FOUND",
        "Caregiver record not found.",
        404
      );
    }

    const [center] = await tx
      .select()
      .from(centers)
      .where(eq(centers.id, caregiver.centerId))
      .limit(1);

    const [provider] = center
      ? await tx
          .select()
          .from(providers)
          .where(eq(providers.id, center.providerId))
          .limit(1)
      : [null];

    // Prevent self-approval by caregiver or provider owner
    if (
      caregiver.userId === params.admin.id ||
      caregiver.email.trim().toLowerCase() ===
        params.admin.email.trim().toLowerCase() ||
      (provider && provider.ownerUserId === params.admin.id)
    ) {
      throw new AdminAuthError(
        "SELF_APPROVAL_FORBIDDEN",
        "Caregivers and provider owners cannot self-approve caregiver background screening.",
        403
      );
    }

    if (
      !caregiver.isActive ||
      caregiver.backgroundCheckStatus === "SUSPENDED"
    ) {
      throw new AdminAuthError(
        "CAREGIVER_SUSPENDED_OR_INACTIVE",
        "Suspended or inactive caregivers cannot be verified while under restriction.",
        400
      );
    }

    const byCg = await safeSelectTable(() =>
      tx
        .select()
        .from(caregiverVerifications)
        .where(eq(caregiverVerifications.caregiverId, caregiver.id))
    );
    const verifRecord = existingVerifs[0] ?? byCg[0] ?? null;

    const allProviderDocs = center
      ? await tx
          .select()
          .from(verificationDocuments)
          .where(eq(verificationDocuments.providerId, center.providerId))
      : [];

    const cgDocs = allProviderDocs.filter(
      (d) =>
        d.caregiverId === caregiver.id ||
        ((verifRecord?.documentReferences ?? []).includes(d.id) &&
          (!d.caregiverId || d.caregiverId === caregiver.id))
    );

    if (cgDocs.length === 0) {
      throw new AdminAuthError(
        "CAREGIVER_EVIDENCE_REQUIRED",
        "Caregiver verification requires at least one submitted and verified screening document.",
        400
      );
    }

    const rejectedDocs = cgDocs.filter((d) => d.status === "REJECTED");
    if (rejectedDocs.length > 0) {
      throw new AdminAuthError(
        "CAREGIVER_DOCUMENT_REJECTED",
        "Cannot approve caregiver screening while a submitted caregiver document is REJECTED.",
        400
      );
    }

    const expiredDocs = cgDocs.filter(
      (d) => d.status === "EXPIRED" || (d.expiresAt !== null && d.expiresAt <= now)
    );
    if (expiredDocs.length > 0) {
      throw new AdminAuthError(
        "CAREGIVER_DOCUMENT_EXPIRED",
        "Cannot approve caregiver screening with expired supporting document(s).",
        400
      );
    }

    const validDocs = cgDocs.filter((d) => isDocumentCurrentlyValid(d, now));
    if (validDocs.length === 0 || validDocs.length < cgDocs.length) {
      throw new AdminAuthError(
        "CAREGIVER_DOCUMENTS_UNVERIFIED",
        "All submitted caregiver screening documents must complete malware scanning (CLEAN) and be individually VERIFIED before caregiver approval.",
        400
      );
    }

    const updatedCaregivers = await tx
      .update(caregivers)
      .set({
        backgroundCheckStatus: "VERIFIED",
        verifiedBy: params.admin.id,
        verifiedAt: now,
        verificationExpiresAt: expiresAt,
        reviewComments: trimmedComments,
        rejectionReason: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(caregivers.id, caregiver.id),
          eq(caregivers.backgroundCheckStatus, caregiver.backgroundCheckStatus)
        )
      )
      .returning();

    if (updatedCaregivers.length === 0) {
      throw new AdminAuthError(
        "VERIFICATION_CONFLICT",
        "Concurrent caregiver verification decision detected.",
        409
      );
    }

    let verifId = verifRecord?.id ?? caregiver.id;
    if (verifRecord) {
      await tx
        .update(caregiverVerifications)
        .set({
          status: "VERIFIED",
          reviewerId: params.admin.id,
          reviewedAt: now,
          reviewComments: trimmedComments,
          rejectionReason: null,
          checklistState: submittedChecklist,
          expiresAt,
          updatedAt: now,
        })
        .where(eq(caregiverVerifications.id, verifRecord.id));
    } else if (center) {
      const [inserted] = await tx
        .insert(caregiverVerifications)
        .values({
          caregiverId: caregiver.id,
          centerId: center.id,
          providerId: center.providerId,
          status: "VERIFIED",
          reviewerId: params.admin.id,
          submittedAt: caregiver.createdAt,
          reviewedAt: now,
          reviewComments: trimmedComments,
          documentReferences: validDocs.map((d) => d.id),
          checklistState: submittedChecklist,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: caregiverVerifications.id });
      if (inserted) verifId = inserted.id;
    }

    await appendVerificationReviewHistory(tx, {
      subjectType: "CAREGIVER",
      subjectId: caregiver.id,
      verificationId: verifId,
      previousStatus: caregiver.backgroundCheckStatus,
      newStatus: "VERIFIED",
      decision: "VERIFIED",
      reviewerId: params.admin.id,
      reviewerEmail: params.admin.email,
      reviewComments: trimmedComments,
      evidenceSnapshot: {
        verifiedDocumentIds: validDocs.map((d) => d.id),
        expiresAt: expiresAt.toISOString(),
      },
      createdAt: now,
    });

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: "CAREGIVER_VERIFICATION_APPROVED",
        entityType: "CAREGIVER_VERIFICATION",
        entityId: caregiver.id,
        summary: `Verified caregiver screening for ${caregiver.fullName} (${caregiver.email}). Comments: ${trimmedComments}`,
        previousState: {
          backgroundCheckStatus: caregiver.backgroundCheckStatus,
        },
        newState: {
          backgroundCheckStatus: "VERIFIED",
          verificationExpiresAt: expiresAt.toISOString(),
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );

    return { caregiver, verifId };
  });

  return {
    verificationId: txResult.verifId,
    caregiverId: txResult.caregiver.id,
    status: "VERIFIED" as const,
    expiresAt: expiresAt.toISOString(),
    reviewedBy: params.admin.email,
    reviewedAt: now.toISOString(),
  };
}

export async function rejectCaregiverVerification(params: {
  idOrCaregiverId: string;
  rejectionReason: string;
  reviewComments?: string;
  suspendCaregiver?: boolean;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const now = new Date();
  const nextStatus: CaregiverVerificationStatus = params.suspendCaregiver
    ? "SUSPENDED"
    : "REJECTED";

  const txResult = await db.transaction(async (tx) => {
    const existingVerifs = await safeSelectTable(() =>
      tx
        .select()
        .from(caregiverVerifications)
        .where(eq(caregiverVerifications.id, params.idOrCaregiverId))
    );
    const resolvedCaregiverId =
      existingVerifs[0]?.caregiverId ?? params.idOrCaregiverId;

    const [caregiver] = await executeWithRowLock(
      tx
        .select()
        .from(caregivers)
        .where(eq(caregivers.id, resolvedCaregiverId))
        .limit(1)
    );

    if (!caregiver) {
      throw new AdminAuthError(
        "CAREGIVER_NOT_FOUND",
        "Caregiver record not found.",
        404
      );
    }

    if (
      caregiver.userId === params.admin.id ||
      caregiver.email.trim().toLowerCase() ===
        params.admin.email.trim().toLowerCase()
    ) {
      throw new AdminAuthError(
        "SELF_APPROVAL_FORBIDDEN",
        "Caregivers cannot review their own verification status.",
        403
      );
    }

    const updatedCaregivers = await tx
      .update(caregivers)
      .set({
        backgroundCheckStatus: nextStatus,
        isActive: params.suspendCaregiver ? false : caregiver.isActive,
        verifiedBy: params.admin.id,
        verifiedAt: now,
        rejectionReason: params.rejectionReason,
        reviewComments: params.reviewComments ?? params.rejectionReason,
        updatedAt: now,
      })
      .where(
        and(
          eq(caregivers.id, caregiver.id),
          eq(caregivers.backgroundCheckStatus, caregiver.backgroundCheckStatus)
        )
      )
      .returning();

    if (updatedCaregivers.length === 0) {
      throw new AdminAuthError(
        "VERIFICATION_CONFLICT",
        "Concurrent caregiver verification decision detected.",
        409
      );
    }

    const [center] = await tx
      .select()
      .from(centers)
      .where(eq(centers.id, caregiver.centerId))
      .limit(1);

    const byCg = await safeSelectTable(() =>
      tx
        .select()
        .from(caregiverVerifications)
        .where(eq(caregiverVerifications.caregiverId, caregiver.id))
    );
    const verifRecord = existingVerifs[0] ?? byCg[0] ?? null;
    let verifId = verifRecord?.id ?? caregiver.id;

    if (verifRecord) {
      await tx
        .update(caregiverVerifications)
        .set({
          status: nextStatus,
          reviewerId: params.admin.id,
          reviewedAt: now,
          rejectionReason: params.rejectionReason,
          reviewComments: params.reviewComments ?? params.rejectionReason,
          updatedAt: now,
        })
        .where(eq(caregiverVerifications.id, verifRecord.id));
    } else if (center) {
      const [inserted] = await tx
        .insert(caregiverVerifications)
        .values({
          caregiverId: caregiver.id,
          centerId: center.id,
          providerId: center.providerId,
          status: nextStatus,
          reviewerId: params.admin.id,
          submittedAt: caregiver.createdAt,
          reviewedAt: now,
          rejectionReason: params.rejectionReason,
          reviewComments: params.reviewComments ?? params.rejectionReason,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: caregiverVerifications.id });
      if (inserted) verifId = inserted.id;
    }

    await appendVerificationReviewHistory(tx, {
      subjectType: "CAREGIVER",
      subjectId: caregiver.id,
      verificationId: verifId,
      previousStatus: caregiver.backgroundCheckStatus,
      newStatus: nextStatus,
      decision: nextStatus,
      reviewerId: params.admin.id,
      reviewerEmail: params.admin.email,
      reviewComments: params.reviewComments ?? params.rejectionReason,
      rejectionReason: params.rejectionReason,
      createdAt: now,
    });

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: params.suspendCaregiver
          ? "CAREGIVER_VERIFICATION_SUSPENDED"
          : "CAREGIVER_VERIFICATION_REJECTED",
        entityType: "CAREGIVER_VERIFICATION",
        entityId: caregiver.id,
        summary: `${nextStatus} caregiver screening for ${caregiver.fullName}. Reason: ${params.rejectionReason}`,
        previousState: {
          backgroundCheckStatus: caregiver.backgroundCheckStatus,
        },
        newState: {
          backgroundCheckStatus: nextStatus,
          rejectionReason: params.rejectionReason,
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );

    return { caregiver, verifId };
  });

  return {
    verificationId: txResult.verifId,
    caregiverId: txResult.caregiver.id,
    status: nextStatus,
    rejectionReason: params.rejectionReason,
    reviewedBy: params.admin.email,
    reviewedAt: now.toISOString(),
  };
}

export async function listAdminVerificationDocuments(filters: {
  status?: string;
  providerId?: string;
  centerId?: string;
  caregiverId?: string;
  search?: string;
}) {
  const [allDocs, allProviders, allCenters, allCaregivers, allUsers] =
    await Promise.all([
      db
        .select()
        .from(verificationDocuments)
        .orderBy(desc(verificationDocuments.createdAt)),
      db.select().from(providers),
      db.select().from(centers),
      db.select().from(caregivers),
      db.select().from(users),
    ]);

  const providerMap = new Map(allProviders.map((p) => [p.id, p]));
  const centerMap = new Map(allCenters.map((c) => [c.id, c]));
  const caregiverMap = new Map(allCaregivers.map((cg) => [cg.id, cg]));
  const userMap = new Map(allUsers.map((u) => [u.id, u]));
  const search = (filters.search || "").trim().toLowerCase();
  const now = new Date();

  return allDocs
    .map((d) => {
      const prov = providerMap.get(d.providerId);
      const center = d.centerId ? centerMap.get(d.centerId) : null;
      const cg = d.caregiverId ? caregiverMap.get(d.caregiverId) : null;
      const reviewer = d.reviewedBy ? userMap.get(d.reviewedBy) : null;
      const isExpired = d.expiresAt !== null && d.expiresAt <= now;
      const effectiveStatus: DocumentVerificationStatus =
        isExpired && d.status !== "REJECTED"
          ? "EXPIRED"
          : (d.status as DocumentVerificationStatus);
      const scanStatus = (d.malwareScanStatus || "PENDING") as MalwareScanStatus;
      const hasTrustedScan =
        scanStatus === "CLEAN" &&
        !d.quarantinedAt &&
        Boolean(d.malwareScannedAt) &&
        Boolean(d.malwareScanProvider);
      const contentAvailable =
        hasTrustedScan && isManagedPrivateStorageReference(d.storageReference);

      return {
        id: d.id,
        providerId: d.providerId,
        providerName: prov?.organizationName ?? "Unknown Provider",
        centerId: d.centerId,
        centerName: center?.name ?? null,
        caregiverId: d.caregiverId ?? null,
        caregiverName: cg?.fullName ?? null,
        documentCategory:
          d.documentCategory ??
          (d.caregiverId ? "CAREGIVER" : d.centerId ? "CENTER" : "PROVIDER"),
        documentType: d.documentType,
        documentTitle: d.documentTitle,
        originalFileName: d.originalFileName ?? null,
        mimeType: d.mimeType,
        fileSizeBytes: d.fileSizeBytes,
        checksumSha256: d.checksumSha256,
        malwareScanStatus: scanStatus,
        malwareScanProvider: d.malwareScanProvider ?? null,
        malwareScannedAt: d.malwareScannedAt
          ? d.malwareScannedAt.toISOString()
          : null,
        malwareScanResult: d.malwareScanResult ?? null,
        quarantinedAt: d.quarantinedAt ? d.quarantinedAt.toISOString() : null,
        scannerConfigured: isMalwareScannerConfigured(),
        contentAvailable,
        status: effectiveStatus,
        isExpired,
        expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
        reviewedByEmail: reviewer?.email ?? null,
        reviewedAt: d.reviewedAt ? d.reviewedAt.toISOString() : null,
        reviewNotes: d.reviewNotes,
        rejectionReason: d.rejectionReason ?? null,
        replacementRequested: d.replacementRequested ?? false,
        accessUrl: buildPrivateDocumentAccessDescriptor(d.id),
        createdAt: d.createdAt.toISOString(),
      };
    })
    .filter((item) => {
      if (
        filters.status &&
        filters.status !== "ALL" &&
        item.status !== filters.status
      ) {
        return false;
      }
      if (filters.providerId && item.providerId !== filters.providerId) {
        return false;
      }
      if (filters.centerId && item.centerId !== filters.centerId) {
        return false;
      }
      if (filters.caregiverId && item.caregiverId !== filters.caregiverId) {
        return false;
      }
      if (
        search &&
        !item.documentTitle.toLowerCase().includes(search) &&
        !item.documentType.toLowerCase().includes(search) &&
        !item.providerName.toLowerCase().includes(search)
      ) {
        return false;
      }
      return true;
    });
}

export async function getAdminVerificationDocumentById(
  docId: string,
  adminId?: string
) {
  const [rawDocRows, historyRows, docs] = await Promise.all([
    db
      .select()
      .from(verificationDocuments)
      .where(eq(verificationDocuments.id, docId))
      .limit(1),
    safeSelectTable(() =>
      db
        .select()
        .from(verificationReviewHistory)
        .orderBy(desc(verificationReviewHistory.createdAt))
    ),
    listAdminVerificationDocuments({}),
  ]);

  const rawDoc = rawDocRows[0];
  const doc = docs.find((d) => d.id === docId);
  if (!doc || !rawDoc) {
    throw new AdminAuthError(
      "DOCUMENT_NOT_FOUND",
      "Verification document not found.",
      404
    );
  }

  let contentAvailable = doc.contentAvailable;
  let checksumVerified = false;
  if (contentAvailable) {
    const accessibility = await verifyStoredDocumentAccessible(
      rawDoc.storageReference,
      rawDoc.checksumSha256
    );
    contentAvailable = accessibility.accessible;
    checksumVerified =
      accessibility.accessible && Boolean(rawDoc.checksumSha256);
  }

  const storageScheme: "s3" | "local" | "unmanaged" =
    rawDoc.storageReference.startsWith("s3-private://")
      ? "s3"
      : rawDoc.storageReference.startsWith("private://")
        ? "local"
        : "unmanaged";

  let recentlyAccessedByCurrentAdmin = false;
  if (adminId && rawDoc.checksumSha256) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
    const accessLogs = await safeSelectTable(() =>
      db
        .select()
        .from(adminAuditLogs)
        .where(
          and(
            eq(adminAuditLogs.entityId, doc.id),
            eq(adminAuditLogs.action, "VERIFICATION_DOCUMENT_ACCESSED")
          )
        )
    );
    recentlyAccessedByCurrentAdmin = accessLogs.some((log) => {
      const state = log.newState as { checksumSha256?: string } | null;
      return (
        log.adminUserId === adminId &&
        log.createdAt >= cutoff &&
        state?.checksumSha256 === rawDoc.checksumSha256
      );
    });
  }

  const canSignAccess = Boolean(
    adminId &&
      doc.malwareScanStatus === "CLEAN" &&
      !doc.quarantinedAt &&
      doc.malwareScannedAt &&
      doc.malwareScanProvider &&
      contentAvailable
  );

  const signedAccessUrl = canSignAccess
    ? `/api/v1/admin/verification-documents/${doc.id}/content?token=${encodeURIComponent(
        createSignedDocumentAccessToken(doc.id, adminId as string, 300)
      )}`
    : null;

  const history = historyRows
    .filter((h) => h.subjectType === "DOCUMENT" && h.subjectId === doc.id)
    .map((h) => ({
      id: h.id,
      previousStatus: h.previousStatus,
      newStatus: h.newStatus,
      decision: h.decision,
      reviewerEmail: h.reviewerEmail,
      reviewComments: h.reviewComments,
      rejectionReason: h.rejectionReason,
      createdAt: h.createdAt.toISOString(),
    }));

  return {
    ...doc,
    contentAvailable,
    checksumVerified,
    storageScheme,
    recentlyAccessedByCurrentAdmin,
    signedAccessUrl,
    history,
    reviewHistory: history,
  };
}

export async function approveVerificationDocument(params: {
  documentId: string;
  reviewNotes: string;
  evidenceReviewed: boolean;
  reviewedChecksumSha256?: string;
  expiresAt?: string;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const trimmedNotes = (params.reviewNotes || "").trim();
  if (trimmedNotes.length < 3) {
    throw new AdminAuthError(
      "REVIEW_NOTES_REQUIRED",
      "Review notes of at least 3 characters are required when approving a document.",
      400
    );
  }

  if (params.evidenceReviewed !== true) {
    throw new AdminAuthError(
      "DOCUMENT_EVIDENCE_REVIEW_REQUIRED",
      "Explicit confirmation that document content has been inspected (evidenceReviewed: true) is required before verifying a document.",
      400
    );
  }

  const now = new Date();
  let parsedOverrideExpiresAt: Date | null = null;
  if (params.expiresAt) {
    parsedOverrideExpiresAt = new Date(params.expiresAt);
    if (
      Number.isNaN(parsedOverrideExpiresAt.getTime()) ||
      parsedOverrideExpiresAt <= now
    ) {
      throw new AdminAuthError(
        "INVALID_EXPIRATION_DATE",
        "Provided document expiration timestamp must be a valid future date.",
        400
      );
    }
  }

  const accessCutoff = new Date(now.getTime() - 24 * 60 * 60_000);

  const txResult = await db.transaction(async (tx) => {
    const [doc] = await executeWithRowLock(
      tx
        .select()
        .from(verificationDocuments)
        .where(eq(verificationDocuments.id, params.documentId))
        .limit(1)
    );

    if (!doc) {
      throw new AdminAuthError(
        "DOCUMENT_NOT_FOUND",
        "Verification document not found.",
        404
      );
    }

    const [provider] = await tx
      .select()
      .from(providers)
      .where(eq(providers.id, doc.providerId))
      .limit(1);

    if (
      doc.uploadedBy === params.admin.id ||
      (provider && provider.ownerUserId === params.admin.id)
    ) {
      throw new AdminAuthError(
        "SELF_APPROVAL_FORBIDDEN",
        "Document uploaders and provider owners cannot self-verify their own documents.",
        403
      );
    }

    // If the stored document is already expired, exit cleanly so expiry can be persisted
    // in its own committed transaction (never lost to a thrown-error rollback).
    if (doc.expiresAt && doc.expiresAt <= now) {
      return { kind: "expired" as const, doc };
    }

    if (!ALLOWED_DOCUMENT_MIME_TYPES.has(doc.mimeType)) {
      throw new AdminAuthError(
        "INVALID_DOCUMENT_TYPE",
        `Unsupported document MIME type '${doc.mimeType}'. Allowed types: PDF, PNG, JPEG.`,
        400
      );
    }

    if (
      doc.fileSizeBytes <= 0 ||
      doc.fileSizeBytes > MAX_DOCUMENT_SIZE_BYTES
    ) {
      throw new AdminAuthError(
        "INVALID_DOCUMENT_SIZE",
        "Document file size is outside allowed compliance bounds (1B – 10 MB).",
        400
      );
    }

    const scanStatus = (doc.malwareScanStatus || "PENDING") as MalwareScanStatus;
    if (
      Boolean(doc.quarantinedAt) ||
      scanStatus !== "CLEAN" ||
      !doc.malwareScannedAt ||
      !doc.malwareScanProvider
    ) {
      throw new AdminAuthError(
        "DOCUMENT_MALWARE_SCAN_REQUIRED",
        `Document cannot be verified until trusted backend malware scanning completes with status CLEAN (current: ${scanStatus}${doc.quarantinedAt ? ", QUARANTINED" : ""}).`,
        400
      );
    }

    const contentCheck = await verifyStoredDocumentAccessible(
      doc.storageReference,
      doc.checksumSha256
    );
    if (!contentCheck.accessible) {
      throw new AdminAuthError(
        "DOCUMENT_CONTENT_UNAVAILABLE",
        contentCheck.reason ||
          "Stored document content is inaccessible or failed integrity verification.",
        400
      );
    }

    const verifiedChecksum = contentCheck.actualSha256 || doc.checksumSha256;
    if (
      params.reviewedChecksumSha256 &&
      verifiedChecksum &&
      params.reviewedChecksumSha256.toLowerCase() !==
        verifiedChecksum.toLowerCase()
    ) {
      throw new AdminAuthError(
        "DOCUMENT_VERSION_MISMATCH",
        "Reviewed document checksum does not match the current stored document version. Please reload and re-inspect.",
        409
      );
    }

    if (doc.status === "VERIFIED") {
      throw new AdminAuthError(
        "DOCUMENT_ALREADY_VERIFIED",
        "This document has already been verified.",
        409
      );
    }

    // Evidence-backed review check: require a recent authorized content access event
    // by this exact reviewer for this exact document checksum.
    const accessLogs = await tx
      .select()
      .from(adminAuditLogs)
      .where(
        and(
          eq(adminAuditLogs.entityId, doc.id),
          eq(adminAuditLogs.action, "VERIFICATION_DOCUMENT_ACCESSED")
        )
      )
      .orderBy(desc(adminAuditLogs.createdAt));

    const matchingAccessLog = accessLogs.find((log) => {
      const state = log.newState as { checksumSha256?: string } | null;
      return (
        log.adminUserId === params.admin.id &&
        log.createdAt >= accessCutoff &&
        (!verifiedChecksum || state?.checksumSha256 === verifiedChecksum)
      );
    });

    if (!matchingAccessLog) {
      throw new AdminAuthError(
        "DOCUMENT_CONTENT_NOT_ACCESSED",
        "You must inspect the authenticated document content preview for this exact file version before verifying it.",
        400
      );
    }

    const nextExpiresAt = parsedOverrideExpiresAt ?? doc.expiresAt;

    const updatedDocs = await tx
      .update(verificationDocuments)
      .set({
        status: "VERIFIED",
        reviewedBy: params.admin.id,
        reviewedAt: now,
        reviewNotes: trimmedNotes,
        rejectionReason: null,
        replacementRequested: false,
        expiresAt: nextExpiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(verificationDocuments.id, doc.id),
          eq(verificationDocuments.status, doc.status)
        )
      )
      .returning();

    if (updatedDocs.length === 0) {
      throw new AdminAuthError(
        "VERIFICATION_CONFLICT",
        "Concurrent document review decision detected.",
        409
      );
    }

    await appendVerificationReviewHistory(tx, {
      subjectType: "DOCUMENT",
      subjectId: doc.id,
      previousStatus: doc.status,
      newStatus: "VERIFIED",
      decision: "VERIFIED",
      reviewerId: params.admin.id,
      reviewerEmail: params.admin.email,
      reviewComments: trimmedNotes,
      evidenceSnapshot: {
        documentType: doc.documentType,
        checksumSha256: verifiedChecksum,
        malwareScanProvider: doc.malwareScanProvider,
        malwareScannedAt: doc.malwareScannedAt?.toISOString() ?? null,
        evidenceReviewed: true,
        evidenceAccessAuditId: matchingAccessLog.id,
        evidenceAccessedAt: matchingAccessLog.createdAt.toISOString(),
      },
      createdAt: now,
    });

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: "VERIFICATION_DOCUMENT_APPROVED",
        entityType: "VERIFICATION_DOCUMENT",
        entityId: doc.id,
        summary: `Verified document "${doc.documentTitle}" (${doc.documentType}). Notes: ${trimmedNotes}`,
        previousState: { status: doc.status },
        newState: {
          status: "VERIFIED",
          documentType: doc.documentType,
          malwareScanProvider: doc.malwareScanProvider,
          checksumSha256: verifiedChecksum,
          evidenceAccessAuditId: matchingAccessLog.id,
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );

    return { kind: "approved" as const, doc, nextExpiresAt, verifiedChecksum };
  });

  if (txResult.kind === "expired") {
    // Persist the EXPIRED transition atomically in its own committed transaction
    // so status, review history, and audit log are durably recorded before returning 400.
    await db.transaction(async (tx) => {
      const [lockedDoc] = await executeWithRowLock(
        tx
          .select()
          .from(verificationDocuments)
          .where(eq(verificationDocuments.id, txResult.doc.id))
          .limit(1)
      );

      if (
        lockedDoc &&
        lockedDoc.status !== "EXPIRED" &&
        lockedDoc.status !== "REJECTED" &&
        lockedDoc.expiresAt &&
        lockedDoc.expiresAt <= now
      ) {
        const expiredRows = await tx
          .update(verificationDocuments)
          .set({
            status: "EXPIRED",
            updatedAt: now,
          })
          .where(
            and(
              eq(verificationDocuments.id, lockedDoc.id),
              eq(verificationDocuments.status, lockedDoc.status)
            )
          )
          .returning({ id: verificationDocuments.id });

        if (expiredRows.length > 0) {
          await appendVerificationReviewHistory(tx, {
            subjectType: "DOCUMENT",
            subjectId: lockedDoc.id,
            previousStatus: lockedDoc.status,
            newStatus: "EXPIRED",
            decision: "EXPIRED",
            reviewerId: params.admin.id,
            reviewerEmail: params.admin.email,
            reviewComments:
              "Document approval blocked and status transitioned to EXPIRED because expiresAt has passed.",
            evidenceSnapshot: {
              documentType: lockedDoc.documentType,
              expiresAt: lockedDoc.expiresAt.toISOString(),
            },
            createdAt: now,
          });

          await recordAdminAuditLog(
            {
              adminUserId: params.admin.id,
              adminEmail: params.admin.email,
              action: "VERIFICATION_DOCUMENT_EXPIRED",
              entityType: "VERIFICATION_DOCUMENT",
              entityId: lockedDoc.id,
              summary: `Marked expired document "${lockedDoc.documentTitle}" (${lockedDoc.documentType}) as EXPIRED during review attempt`,
              previousState: { status: lockedDoc.status },
              newState: {
                status: "EXPIRED",
                expiresAt: lockedDoc.expiresAt.toISOString(),
              },
              ipAddress: params.ipAddress,
              userAgent: params.userAgent,
            },
            tx
          );
        }
      }
    });

    throw new AdminAuthError(
      "DOCUMENT_EXPIRED",
      "Cannot verify an expired document. The document has been marked EXPIRED; please request a replacement document.",
      400
    );
  }

  return {
    documentId: txResult.doc.id,
    status: "VERIFIED" as const,
    checksumSha256: txResult.verifiedChecksum,
    reviewedBy: params.admin.email,
    reviewedAt: now.toISOString(),
  };
}

export async function rejectVerificationDocument(params: {
  documentId: string;
  rejectionReason: string;
  reviewNotes?: string;
  requestReplacement?: boolean;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const now = new Date();

  const txResult = await db.transaction(async (tx) => {
    const [doc] = await executeWithRowLock(
      tx
        .select()
        .from(verificationDocuments)
        .where(eq(verificationDocuments.id, params.documentId))
        .limit(1)
    );

    if (!doc) {
      throw new AdminAuthError(
        "DOCUMENT_NOT_FOUND",
        "Verification document not found.",
        404
      );
    }

    const [provider] = await tx
      .select()
      .from(providers)
      .where(eq(providers.id, doc.providerId))
      .limit(1);

    if (
      doc.uploadedBy === params.admin.id ||
      (provider && provider.ownerUserId === params.admin.id)
    ) {
      throw new AdminAuthError(
        "SELF_APPROVAL_FORBIDDEN",
        "Document uploaders and provider owners cannot review their own documents.",
        403
      );
    }

    const updatedDocs = await tx
      .update(verificationDocuments)
      .set({
        status: "REJECTED",
        reviewedBy: params.admin.id,
        reviewedAt: now,
        rejectionReason: params.rejectionReason,
        reviewNotes: params.reviewNotes ?? params.rejectionReason,
        replacementRequested: Boolean(params.requestReplacement ?? true),
        updatedAt: now,
      })
      .where(
        and(
          eq(verificationDocuments.id, doc.id),
          eq(verificationDocuments.status, doc.status)
        )
      )
      .returning();

    if (updatedDocs.length === 0) {
      throw new AdminAuthError(
        "VERIFICATION_CONFLICT",
        "Concurrent document review decision detected.",
        409
      );
    }

    await appendVerificationReviewHistory(tx, {
      subjectType: "DOCUMENT",
      subjectId: doc.id,
      previousStatus: doc.status,
      newStatus: "REJECTED",
      decision: "REJECTED",
      reviewerId: params.admin.id,
      reviewerEmail: params.admin.email,
      reviewComments: params.reviewNotes ?? params.rejectionReason,
      rejectionReason: params.rejectionReason,
      evidenceSnapshot: {
        documentType: doc.documentType,
        replacementRequested: Boolean(params.requestReplacement ?? true),
      },
      createdAt: now,
    });

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: "VERIFICATION_DOCUMENT_REJECTED",
        entityType: "VERIFICATION_DOCUMENT",
        entityId: doc.id,
        summary: `Rejected document "${doc.documentTitle}" (${doc.documentType}). Reason: ${params.rejectionReason}`,
        previousState: { status: doc.status },
        newState: {
          status: "REJECTED",
          rejectionReason: params.rejectionReason,
          replacementRequested: Boolean(params.requestReplacement ?? true),
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );

    return { doc };
  });

  return {
    documentId: txResult.doc.id,
    status: "REJECTED" as const,
    rejectionReason: params.rejectionReason,
    replacementRequested: Boolean(params.requestReplacement ?? true),
    reviewedBy: params.admin.email,
    reviewedAt: now.toISOString(),
  };
}

// ==========================================
// 4. Booking Oversight & State Transitions
// ==========================================

export async function listAdminBookings(filters: {
  search?: string;
  status?: string;
  centerId?: string;
  providerId?: string;
}) {

  const [allBookings, allUsers, allCenters, allProviders, allChildren, allDisputes] =
    await Promise.all([
      db.select().from(bookings).orderBy(desc(bookings.createdAt)),
      db.select().from(users),
      db.select().from(centers),
      db.select().from(providers),
      db.select().from(children),
      db.select().from(disputes),
    ]);

  const userMap = new Map(allUsers.map((u) => [u.id, u]));
  const centerMap = new Map(allCenters.map((c) => [c.id, c]));
  const providerMap = new Map(allProviders.map((p) => [p.id, p]));
  const childMap = new Map(allChildren.map((ch) => [ch.id, ch]));
  const search = (filters.search || "").trim().toLowerCase();

  return allBookings
    .filter((b) => {
      if (
        filters.status &&
        filters.status !== "ALL" &&
        b.status !== filters.status
      ) {
        return false;
      }
      if (
        filters.centerId &&
        filters.centerId !== "ALL" &&
        b.centerId !== filters.centerId
      ) {
        return false;
      }
      if (
        filters.providerId &&
        filters.providerId !== "ALL" &&
        b.providerId !== filters.providerId
      ) {
        return false;
      }
      if (search) {
        const parentName = userMap.get(b.parentId)?.name.toLowerCase() ?? "";
        const centerName = centerMap.get(b.centerId)?.name.toLowerCase() ?? "";
        if (
          !b.bookingReference.toLowerCase().includes(search) &&
          !parentName.includes(search) &&
          !centerName.includes(search)
        ) {
          return false;
        }
      }
      return true;
    })
    .map((b) => {
      const center = centerMap.get(b.centerId);
      const provider = providerMap.get(b.providerId);
      const parent = userMap.get(b.parentId);
      const child = childMap.get(b.childId);
      const bookingDisputes = allDisputes.filter((d) => d.bookingId === b.id);
      const capacityWarning =
        center !== undefined &&
        center.currentOccupancy >= center.approvedCapacity;

      return {
        id: b.id,
        bookingReference: b.bookingReference,
        parentId: b.parentId,
        parentName: parent?.name ?? "Registered Parent",
        parentEmail: parent?.email ?? "",
        childAgeGroup: child?.ageGroup ?? "Toddler (1-3y)",
        providerId: b.providerId,
        providerName: provider?.organizationName ?? "Unknown Provider",
        centerId: b.centerId,
        centerName: center?.name ?? "Unknown Centre",
        centerCapacity: center?.approvedCapacity ?? 0,
        centerOccupancy: center?.currentOccupancy ?? 0,
        capacityWarning,
        status: b.status,
        careType: b.careType,
        startTime: b.startTime.toISOString(),
        endTime: b.endTime.toISOString(),
        totalAmount: b.totalAmount,
        paymentStatus: b.paymentStatus,
        hasConflict: b.hasConflict || capacityWarning,
        cancellationReason: b.cancellationReason,
        disputesCount: bookingDisputes.length,
        allowedTransitions: ALLOWED_BOOKING_TRANSITIONS[b.status] ?? [],
        createdAt: b.createdAt.toISOString(),
      };
    });
}

export async function getAdminBookingById(bookingId: string) {

  const [booking] = await db
    .select()
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);

  if (!booking) {
    throw new AdminAuthError("BOOKING_NOT_FOUND", "Booking not found.", 404);
  }

  const [historyRows, disputeRows, allUsers, centerRows, providerRows, childRows] =
    await Promise.all([
      db
        .select()
        .from(bookingStatusHistory)
        .where(eq(bookingStatusHistory.bookingId, booking.id))
        .orderBy(desc(bookingStatusHistory.createdAt)),
      db.select().from(disputes).where(eq(disputes.bookingId, booking.id)),
      db.select().from(users),
      db.select().from(centers).where(eq(centers.id, booking.centerId)).limit(1),
      db
        .select()
        .from(providers)
        .where(eq(providers.id, booking.providerId))
        .limit(1),
      db
        .select()
        .from(children)
        .where(eq(children.id, booking.childId))
        .limit(1),
    ]);

  const userMap = new Map(allUsers.map((u) => [u.id, u]));
  const center = centerRows[0] ?? null;
  const provider = providerRows[0] ?? null;
  const child = childRows[0] ?? null;
  const parent = userMap.get(booking.parentId);

  return {
    ...booking,
    startTime: booking.startTime.toISOString(),
    endTime: booking.endTime.toISOString(),
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
    parent: parent
      ? { id: parent.id, name: parent.name, email: parent.email, phone: parent.phone }
      : null,
    childSummary: child
      ? {
          id: child.id,
          displayInitial: `${child.firstName.charAt(0)}.`,
          ageGroup: child.ageGroup,
          ageMonths: child.ageMonths,
        }
      : null,
    center: center
      ? {
          id: center.id,
          name: center.name,
          city: center.city,
          approvedCapacity: center.approvedCapacity,
          currentOccupancy: center.currentOccupancy,
        }
      : null,
    provider: provider
      ? { id: provider.id, organizationName: provider.organizationName }
      : null,
    allowedTransitions: ALLOWED_BOOKING_TRANSITIONS[booking.status] ?? [],
    history: historyRows.map((h) => ({
      id: h.id,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      changedByName: h.changedBy ? userMap.get(h.changedBy)?.name ?? "System" : "System",
      reason: h.reason,
      createdAt: h.createdAt.toISOString(),
    })),
    disputes: disputeRows.map((d) => ({
      id: d.id,
      disputeReference: d.disputeReference,
      reason: d.reason,
      description: d.description,
      status: d.status,
      resolutionNotes: d.resolutionNotes,
      createdAt: d.createdAt.toISOString(),
    })),
  };
}

export async function getAdminBookingHistory(bookingId: string) {
  const details = await getAdminBookingById(bookingId);
  return details.history;
}

export async function transitionAdminBookingStatus(params: {
  bookingId: string;
  toStatus: BookingStatus;
  reason: string;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const bookingId = await db.transaction(async (tx) => {
    const [booking] = await executeWithRowLock(
      tx
        .select()
        .from(bookings)
        .where(eq(bookings.id, params.bookingId))
        .limit(1)
    );

    if (!booking) {
      throw new AdminAuthError("BOOKING_NOT_FOUND", "Booking not found.", 404);
    }

    const allowed = ALLOWED_BOOKING_TRANSITIONS[booking.status] ?? [];
    if (!allowed.includes(params.toStatus)) {
      throw new AdminAuthError(
        "INVALID_BOOKING_STATE_TRANSITION",
        `Invalid booking state transition from ${booking.status} to ${params.toStatus}. Allowed transitions: ${allowed.join(", ") || "none"}.`,
        400
      );
    }

    const [center] = await tx
      .select()
      .from(centers)
      .where(eq(centers.id, booking.centerId))
      .limit(1);

    if (!center) {
      throw new AdminAuthError("CENTER_NOT_FOUND", "Centre not found.", 404);
    }

    // Prevent suspended, rejected, or unverified centres from accepting or confirming bookings
    if (params.toStatus === "CONFIRMED" || params.toStatus === "CHECKED_IN") {
      if (
        center.listingStatus !== "ACTIVE" ||
        center.verificationStatus !== "APPROVED"
      ) {
        throw new AdminAuthError(
          "CENTER_UNAVAILABLE_FOR_BOOKING",
          `Cannot confirm or check in booking: ${center.name} is not an active, approved centre (listingStatus=${center.listingStatus}, verificationStatus=${center.verificationStatus}).`,
          400
        );
      }

      const [centerProvider] = await tx
        .select()
        .from(providers)
        .where(eq(providers.id, center.providerId))
        .limit(1);

      if (
        !centerProvider ||
        centerProvider.verificationStatus !== "APPROVED" ||
        !centerProvider.subscriptionActive
      ) {
        throw new AdminAuthError(
          "CENTER_UNAVAILABLE_FOR_BOOKING",
          `Cannot confirm or check in booking: parent provider for ${center.name} is not active and approved.`,
          400
        );
      }
    }

    // Enforce childcare capacity constraint when confirming or checking in
    if (
      (params.toStatus === "CONFIRMED" || params.toStatus === "CHECKED_IN") &&
      booking.status === "REQUESTED" &&
      center.currentOccupancy >= center.approvedCapacity
    ) {
      throw new AdminAuthError(
        "CAPACITY_LIMIT_EXCEEDED",
        `Cannot confirm booking: ${center.name} is at full approved capacity (${center.currentOccupancy}/${center.approvedCapacity}).`,
        400
      );
    }

    const now = new Date();
    const updatedBookings = await tx
      .update(bookings)
      .set({
        status: params.toStatus,
        cancellationReason:
          params.toStatus === "CANCELLED" || params.toStatus === "REJECTED"
            ? params.reason
            : booking.cancellationReason,
        updatedAt: now,
      })
      .where(and(eq(bookings.id, booking.id), eq(bookings.status, booking.status)))
      .returning({ id: bookings.id });

    if (updatedBookings.length === 0) {
      throw new AdminAuthError(
        "BOOKING_TRANSITION_CONFLICT",
        "Concurrent booking status transition detected.",
        409
      );
    }

    await tx.insert(bookingStatusHistory).values({
      bookingId: booking.id,
      fromStatus: booking.status,
      toStatus: params.toStatus,
      changedBy: params.admin.id,
      reason: params.reason,
      createdAt: now,
    });

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: "BOOKING_STATUS_TRANSITIONED",
        entityType: "BOOKING",
        entityId: booking.id,
        summary: `Transitioned booking ${booking.bookingReference} from ${booking.status} to ${params.toStatus}. Reason: ${params.reason}`,
        previousState: { status: booking.status },
        newState: { status: params.toStatus, reason: params.reason },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );

    return booking.id;
  });

  return getAdminBookingById(bookingId);
}

// ==========================================
// 5. Safety Incidents & Complaints
// ==========================================

export async function listAdminIncidents(filters: {
  status?: string;
  severity?: string;
  category?: string;
  search?: string;
}) {

  const [allIncidents, allCenters, allBookings, allUsers] = await Promise.all([
    db.select().from(safetyIncidents).orderBy(desc(safetyIncidents.occurredAt)),
    db.select().from(centers),
    db.select().from(bookings),
    db.select().from(users),
  ]);

  const centerMap = new Map(allCenters.map((c) => [c.id, c]));
  const bookingMap = new Map(allBookings.map((b) => [b.id, b]));
  const userMap = new Map(allUsers.map((u) => [u.id, u]));
  const search = (filters.search || "").trim().toLowerCase();

  return allIncidents
    .filter((inc) => {
      if (
        filters.status &&
        filters.status !== "ALL" &&
        inc.status !== filters.status
      ) {
        return false;
      }
      if (
        filters.severity &&
        filters.severity !== "ALL" &&
        inc.severity !== filters.severity
      ) {
        return false;
      }
      if (
        filters.category &&
        filters.category !== "ALL" &&
        inc.category !== filters.category
      ) {
        return false;
      }
      if (
        search &&
        !inc.incidentReference.toLowerCase().includes(search) &&
        !inc.title.toLowerCase().includes(search) &&
        !inc.description.toLowerCase().includes(search)
      ) {
        return false;
      }
      return true;
    })
    .map((inc) => {
      const center = centerMap.get(inc.centerId);
      const booking = inc.bookingId ? bookingMap.get(inc.bookingId) : null;
      const assignedAdmin = inc.assignedAdminId
        ? userMap.get(inc.assignedAdminId)
        : null;

      return {
        id: inc.id,
        incidentReference: inc.incidentReference,
        centerId: inc.centerId,
        centerName: center?.name ?? "Unknown Centre",
        bookingId: inc.bookingId,
        bookingReference: booking?.bookingReference ?? null,
        assignedAdminId: inc.assignedAdminId,
        assignedAdminName: assignedAdmin?.name ?? "Unassigned",
        assignedAdminEmail: assignedAdmin?.email ?? null,
        category: inc.category,
        severity: inc.severity,
        status: inc.status,
        title: inc.title,
        description: inc.description,
        resolutionOutcome: inc.resolutionOutcome,
        occurredAt: inc.occurredAt.toISOString(),
        resolvedAt: inc.resolvedAt ? inc.resolvedAt.toISOString() : null,
        createdAt: inc.createdAt.toISOString(),
      };
    });
}

export async function getAdminIncidentById(incidentId: string) {

  const [incident] = await db
    .select()
    .from(safetyIncidents)
    .where(eq(safetyIncidents.id, incidentId))
    .limit(1);

  if (!incident) {
    throw new AdminAuthError(
      "INCIDENT_NOT_FOUND",
      "Safety incident record not found.",
      404
    );
  }

  const [activities, centerRows, bookingRows, allUsers] = await Promise.all([
    db
      .select()
      .from(incidentActivity)
      .where(eq(incidentActivity.incidentId, incident.id))
      .orderBy(desc(incidentActivity.createdAt)),
    db.select().from(centers).where(eq(centers.id, incident.centerId)).limit(1),
    incident.bookingId
      ? db
          .select()
          .from(bookings)
          .where(eq(bookings.id, incident.bookingId))
          .limit(1)
      : Promise.resolve([]),
    db.select().from(users),
  ]);

  const userMap = new Map(allUsers.map((u) => [u.id, u]));
  const center = centerRows[0] ?? null;
  const booking = bookingRows[0] ?? null;
  const assignedAdmin = incident.assignedAdminId
    ? userMap.get(incident.assignedAdminId)
    : null;
  const availableAdmins = allUsers
    .filter(
      (u) =>
        (u.role === "ADMIN" || u.role === "SUPER_ADMIN") &&
        u.status === "ACTIVE"
    )
    .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role }));

  return {
    id: incident.id,
    incidentReference: incident.incidentReference,
    centerId: incident.centerId,
    centerName: center?.name ?? "Unknown Centre",
    centerCity: center?.city ?? "",
    bookingId: incident.bookingId,
    bookingReference: booking?.bookingReference ?? null,
    assignedAdminId: incident.assignedAdminId,
    assignedAdminName: assignedAdmin?.name ?? "Unassigned",
    assignedAdminEmail: assignedAdmin?.email ?? null,
    category: incident.category,
    severity: incident.severity,
    status: incident.status,
    title: incident.title,
    description: incident.description,
    resolutionOutcome: incident.resolutionOutcome,
    occurredAt: incident.occurredAt.toISOString(),
    resolvedAt: incident.resolvedAt ? incident.resolvedAt.toISOString() : null,
    createdAt: incident.createdAt.toISOString(),
    availableAdmins,
    activities: activities.map((act) => ({
      id: act.id,
      actionType: act.actionType,
      fromStatus: act.fromStatus,
      toStatus: act.toStatus,
      note: act.note,
      actorName: act.actorId ? userMap.get(act.actorId)?.name ?? "Admin" : "System",
      actorEmail: act.actorId ? userMap.get(act.actorId)?.email ?? null : null,
      createdAt: act.createdAt.toISOString(),
    })),
  };
}

export async function updateAdminIncidentStatus(params: {
  incidentId: string;
  status: IncidentStatus;
  assignedAdminId?: string | null;
  resolutionOutcome?: string;
  note: string;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const incidentId = await db.transaction(async (tx) => {
    const [incident] = await executeWithRowLock(
      tx
        .select()
        .from(safetyIncidents)
        .where(eq(safetyIncidents.id, params.incidentId))
        .limit(1)
    );

    if (!incident) {
      throw new AdminAuthError(
        "INCIDENT_NOT_FOUND",
        "Safety incident record not found.",
        404
      );
    }

    const now = new Date();
    const isResolving =
      params.status === "RESOLVED" || params.status === "CLOSED";

    await tx
      .update(safetyIncidents)
      .set({
        status: params.status,
        assignedAdminId:
          params.assignedAdminId !== undefined
            ? params.assignedAdminId
            : incident.assignedAdminId,
        resolutionOutcome:
          params.resolutionOutcome !== undefined
            ? params.resolutionOutcome
            : incident.resolutionOutcome,
        resolvedAt: isResolving ? now : incident.resolvedAt,
        updatedAt: now,
      })
      .where(eq(safetyIncidents.id, incident.id));

    await tx.insert(incidentActivity).values({
      incidentId: incident.id,
      actorId: params.admin.id,
      actionType: isResolving ? "RESOLUTION_RECORDED" : "STATUS_CHANGED",
      fromStatus: incident.status,
      toStatus: params.status,
      note: params.note,
      createdAt: now,
    });

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: "INCIDENT_STATUS_UPDATED",
        entityType: "SAFETY_INCIDENT",
        entityId: incident.id,
        summary: `Updated incident ${incident.incidentReference} from ${incident.status} to ${params.status}. Note: ${params.note}`,
        previousState: { status: incident.status },
        newState: {
          status: params.status,
          resolutionOutcome: params.resolutionOutcome,
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );

    return incident.id;
  });

  return getAdminIncidentById(incidentId);
}

export async function addAdminIncidentNote(params: {
  incidentId: string;
  note: string;
  assignedAdminId?: string;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const incidentId = await db.transaction(async (tx) => {
    const [incident] = await executeWithRowLock(
      tx
        .select()
        .from(safetyIncidents)
        .where(eq(safetyIncidents.id, params.incidentId))
        .limit(1)
    );

    if (!incident) {
      throw new AdminAuthError(
        "INCIDENT_NOT_FOUND",
        "Safety incident record not found.",
        404
      );
    }

    const now = new Date();

    if (params.assignedAdminId) {
      await tx
        .update(safetyIncidents)
        .set({
          assignedAdminId: params.assignedAdminId,
          updatedAt: now,
        })
        .where(eq(safetyIncidents.id, incident.id));
    }

    await tx.insert(incidentActivity).values({
      incidentId: incident.id,
      actorId: params.admin.id,
      actionType: params.assignedAdminId ? "ASSIGNED" : "NOTE_ADDED",
      fromStatus: incident.status,
      toStatus: incident.status,
      note: params.note,
      createdAt: now,
    });

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: "INCIDENT_NOTE_ADDED",
        entityType: "SAFETY_INCIDENT",
        entityId: incident.id,
        summary: `Added investigation note to incident ${incident.incidentReference}`,
        newState: { note: params.note },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );

    return incident.id;
  });

  return getAdminIncidentById(incidentId);
}

// ==========================================
// 6. Reports, Audit Logs & Settings
// ==========================================

export async function getAdminReportsData() {

  const [
    allUsers,
    allProviders,
    allCenters,
    allBookings,
    allIncidents,
    allDisputes,
  ] = await Promise.all([
    db.select().from(users),
    db.select().from(providers),
    db.select().from(centers),
    db.select().from(bookings),
    db.select().from(safetyIncidents),
    db.select().from(disputes),
  ]);

  const paidBookings = allBookings.filter((b) => b.paymentStatus === "PAID");
  const totalGrossBookingValue = paidBookings.reduce(
    (sum, b) => sum + Number(b.totalAmount || 0),
    0
  );

  const cityDistributionMap = new Map<
    string,
    { city: string; centersCount: number; totalCapacity: number; totalOccupancy: number }
  >();

  for (const c of allCenters) {
    const existing = cityDistributionMap.get(c.city) ?? {
      city: c.city,
      centersCount: 0,
      totalCapacity: 0,
      totalOccupancy: 0,
    };
    existing.centersCount += 1;
    existing.totalCapacity += c.approvedCapacity;
    existing.totalOccupancy += c.currentOccupancy;
    cityDistributionMap.set(c.city, existing);
  }

  return {
    financialSummary: {
      totalGrossBookingValue: totalGrossBookingValue.toFixed(2),
      paidBookingsCount: paidBookings.length,
      disputedBookingsCount: allBookings.filter(
        (b) => b.paymentStatus === "DISPUTED"
      ).length,
      openDisputesCount: allDisputes.filter((d) => d.status === "OPEN").length,
      activeProviderSubscriptions: allProviders.filter(
        (p) => p.subscriptionActive
      ).length,
    },
    complianceMetrics: {
      totalProviders: allProviders.length,
      approvedProviders: allProviders.filter(
        (p) => p.verificationStatus === "APPROVED"
      ).length,
      pendingOrUnderReviewProviders: allProviders.filter(
        (p) =>
          p.verificationStatus === "PENDING" ||
          p.verificationStatus === "UNDER_REVIEW"
      ).length,
      centers24x7Count: allCenters.filter((c) => c.is24x7).length,
      resolvedIncidentsCount: allIncidents.filter(
        (i) => i.status === "RESOLVED" || i.status === "CLOSED"
      ).length,
      openIncidentsCount: allIncidents.filter(
        (i) => i.status !== "RESOLVED" && i.status !== "CLOSED"
      ).length,
    },
    cityDistribution: Array.from(cityDistributionMap.values()),
    roleBreakdown: [
      {
        role: "PARENT",
        count: allUsers.filter((u) => u.role === "PARENT").length,
      },
      {
        role: "PROVIDER",
        count: allUsers.filter((u) => u.role === "PROVIDER").length,
      },
      {
        role: "CAREGIVER",
        count: allUsers.filter((u) => u.role === "CAREGIVER").length,
      },
      {
        role: "ADMIN",
        count: allUsers.filter((u) => u.role === "ADMIN").length,
      },
      {
        role: "SUPER_ADMIN",
        count: allUsers.filter((u) => u.role === "SUPER_ADMIN").length,
      },
    ],
  };
}

export async function listAdminAuditLogs(filters: {
  action?: string;
  entityType?: string;
  search?: string;
  limit?: number;
}) {

  const rows = await db
    .select()
    .from(adminAuditLogs)
    .orderBy(desc(adminAuditLogs.createdAt))
    .limit(Math.min(200, Math.max(10, Number(filters.limit || 100))));

  const search = (filters.search || "").trim().toLowerCase();

  return rows
    .filter((row) => {
      if (
        filters.action &&
        filters.action !== "ALL" &&
        row.action !== filters.action
      ) {
        return false;
      }
      if (
        filters.entityType &&
        filters.entityType !== "ALL" &&
        row.entityType !== filters.entityType
      ) {
        return false;
      }
      if (
        search &&
        !row.adminEmail.toLowerCase().includes(search) &&
        !row.summary.toLowerCase().includes(search) &&
        !row.action.toLowerCase().includes(search)
      ) {
        return false;
      }
      return true;
    })
    .map((row) => ({
      id: row.id,
      adminUserId: row.adminUserId,
      adminEmail: row.adminEmail,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      summary: row.summary,
      previousState: row.previousState,
      newState: row.newState,
      ipAddress: row.ipAddress,
      integrityHash: row.integrityHash,
      createdAt: row.createdAt.toISOString(),
    }));
}

export async function getAdminPlatformSettings() {

  const rows = await db.select().from(platformSettings);
  return rows
    .filter(
      (r) =>
        r.category !== "RATE_LIMIT_INTERNAL" &&
        !r.settingKey.startsWith("ratelimit:")
    )
    .map((r) => ({
      id: r.id,
      settingKey: r.settingKey,
      settingValue: r.settingValue,
      category: r.category,
      description: r.description,
      updatedAt: r.updatedAt.toISOString(),
    }));
}

export async function updateAdminPlatformSettings(params: {
  settings: Array<{
    settingKey: string;
    settingValue: unknown;
    category?: string;
    description?: string;
  }>;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const now = new Date();

  await db.transaction(async (tx) => {
    for (const item of params.settings) {
      if (
        item.settingKey.startsWith("ratelimit:") ||
        item.category === "RATE_LIMIT_INTERNAL"
      ) {
        throw new AdminAuthError(
          "RESERVED_SETTING_KEY",
          "Cannot modify internal rate-limiting state through platform settings.",
          400
        );
      }
      const [existing] = await executeWithRowLock(
        tx
          .select()
          .from(platformSettings)
          .where(eq(platformSettings.settingKey, item.settingKey))
          .limit(1)
      );

      if (existing) {
        await tx
          .update(platformSettings)
          .set({
            settingValue: item.settingValue,
            category: item.category ?? existing.category,
            description: item.description ?? existing.description,
            updatedByAdminId: params.admin.id,
            updatedAt: now,
          })
          .where(eq(platformSettings.id, existing.id));
      } else {
        await tx.insert(platformSettings).values({
          settingKey: item.settingKey,
          settingValue: item.settingValue,
          category: item.category ?? "GENERAL",
          description: item.description ?? "",
          updatedByAdminId: params.admin.id,
          updatedAt: now,
        });
      }
    }

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: "PLATFORM_SETTINGS_UPDATED",
        entityType: "PLATFORM_SETTINGS",
        summary: `Updated ${params.settings.length} platform setting(s): ${params.settings.map((s) => s.settingKey).join(", ")}`,
        newState: {
          updatedKeys: params.settings.map((s) => ({
            key: s.settingKey,
            value: s.settingValue,
          })),
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );
  });

  return getAdminPlatformSettings();
}

export async function inspectPhase2HistoricalDataImpact() {
  const [allCaregivers, allCenters, allBookings, allAdmins] = await Promise.all([
    db.select().from(caregivers),
    db.select().from(centers),
    db.select().from(bookings),
    db.select().from(adminProfiles),
  ]);

  const unreviewedVerifiedCaregivers = allCaregivers.filter(
    (c) => c.backgroundCheckStatus === "VERIFIED" && (!c.verifiedBy || !c.verifiedAt)
  );
  const unreviewedActiveCenters = allCenters.filter(
    (c) =>
      (c.listingStatus === "ACTIVE" || c.verificationStatus === "APPROVED") &&
      (!c.verifiedBy || !c.verifiedAt)
  );
  const defaultRatedCenters = allCenters.filter((c) => c.rating === "4.80");
  const unconfirmedPaidBookings = allBookings.filter(
    (b) => b.paymentStatus === "PAID" && b.status !== "COMPLETED"
  );

  return {
    totalCaregivers: allCaregivers.length,
    unreviewedVerifiedCaregiverCount: unreviewedVerifiedCaregivers.length,
    unreviewedVerifiedCaregiverIds: unreviewedVerifiedCaregivers.map((c) => c.id),
    totalCenters: allCenters.length,
    unreviewedActiveCenterCount: unreviewedActiveCenters.length,
    unreviewedActiveCenterIds: unreviewedActiveCenters.map((c) => c.id),
    defaultRatedCenterCount: defaultRatedCenters.length,
    defaultRatedCenterIds: defaultRatedCenters.map((c) => c.id),
    totalBookings: allBookings.length,
    unconfirmedPaidBookingCount: unconfirmedPaidBookings.length,
    totalAdminProfiles: allAdmins.length,
  };
}

/**
 * Read-only Final Phase 2.1 compliance diagnostic report identifying historical
 * verification documents lacking trusted scan provenance, checksums, durable
 * storage content, consistent scan metadata, or non-expired validity.
 * Never mutates or deletes any database record or file.
 */
export async function inspectHistoricalCleanDocumentsImpact() {
  const allDocs = await db.select().from(verificationDocuments);
  const now = new Date();

  const cleanWithoutProviderIds: string[] = [];
  const cleanWithoutTimestampIds: string[] = [];
  const missingChecksumIds: string[] = [];
  const unavailableStoredContentIds: string[] = [];
  const nonManagedStorageIds: string[] = [];
  const inconsistentScanMetadataIds: string[] = [];
  const expiredVerifiedDocumentIds: string[] = [];
  const quarantinedIds: string[] = [];
  const reviewRequiredSet = new Set<string>();

  for (const d of allDocs) {
    const isQuarantined =
      d.malwareScanStatus === "INFECTED" || Boolean(d.quarantinedAt);
    if (isQuarantined) {
      quarantinedIds.push(d.id);
    }

    if (d.malwareScanStatus === "CLEAN" && !d.malwareScanProvider) {
      cleanWithoutProviderIds.push(d.id);
      reviewRequiredSet.add(d.id);
    }

    if (d.malwareScanStatus === "CLEAN" && !d.malwareScannedAt) {
      cleanWithoutTimestampIds.push(d.id);
      reviewRequiredSet.add(d.id);
    }

    if (!d.checksumSha256 || !/^[0-9a-fA-F]{64}$/.test(d.checksumSha256)) {
      missingChecksumIds.push(d.id);
      reviewRequiredSet.add(d.id);
    }

    if (!isManagedPrivateStorageReference(d.storageReference)) {
      nonManagedStorageIds.push(d.id);
      unavailableStoredContentIds.push(d.id);
      reviewRequiredSet.add(d.id);
    } else {
      const check = await verifyStoredDocumentAccessible(
        d.storageReference,
        d.checksumSha256
      );
      if (!check.accessible) {
        unavailableStoredContentIds.push(d.id);
        reviewRequiredSet.add(d.id);
      }
    }

    const hasInconsistentMeta =
      (d.malwareScanStatus === "INFECTED" && !d.quarantinedAt) ||
      (Boolean(d.quarantinedAt) &&
        (d.malwareScanStatus === "CLEAN" || d.status === "VERIFIED")) ||
      (d.malwareScanStatus === "CLEAN" &&
        d.malwareScanProvider === "UNCONFIGURED") ||
      (d.malwareScanStatus === "PENDING" && Boolean(d.malwareScannedAt));
    if (hasInconsistentMeta) {
      inconsistentScanMetadataIds.push(d.id);
      reviewRequiredSet.add(d.id);
    }

    if (d.status === "VERIFIED" && d.expiresAt && d.expiresAt <= now) {
      expiredVerifiedDocumentIds.push(d.id);
      reviewRequiredSet.add(d.id);
    }
  }

  const historicalUnscannedCleanIds = Array.from(
    new Set([...cleanWithoutProviderIds, ...cleanWithoutTimestampIds])
  );
  const documentsRequiringReviewIds = Array.from(reviewRequiredSet);

  return {
    generatedAt: now.toISOString(),
    readOnly: true as const,
    totalDocuments: allDocs.length,
    historicalUnscannedCleanCount: historicalUnscannedCleanIds.length,
    historicalUnscannedCleanIds,
    cleanWithoutProviderCount: cleanWithoutProviderIds.length,
    cleanWithoutProviderIds,
    cleanWithoutTimestampCount: cleanWithoutTimestampIds.length,
    cleanWithoutTimestampIds,
    missingChecksumCount: missingChecksumIds.length,
    missingChecksumIds,
    unavailableStoredContentCount: unavailableStoredContentIds.length,
    unavailableStoredContentIds,
    nonManagedStorageCount: nonManagedStorageIds.length,
    nonManagedStorageIds,
    inconsistentScanMetadataCount: inconsistentScanMetadataIds.length,
    inconsistentScanMetadataIds,
    expiredVerifiedDocumentCount: expiredVerifiedDocumentIds.length,
    expiredVerifiedDocumentIds,
    quarantinedCount: quarantinedIds.length,
    quarantinedIds,
    documentsRequiringReviewCount: documentsRequiringReviewIds.length,
    documentsRequiringReviewIds,
    remediationGuidance: [
      "Do not overwrite historical records automatically; preserve audit history.",
      "Documents missing trusted scan provenance are already excluded from new provider/centre/caregiver approvals.",
      "Run migrateLocalDocumentsToPersistentStorage (dryRun first) for legacy private:// files that remain accessible.",
      "For unavailable or unverified legacy files, request replacement documents through the Admin Verification UI.",
    ],
  };
}
