import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../config/db";
import {
  adminAuditLogs,
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
  platformSettings,
  providers,
  providerVerifications,
  safetyIncidents,
  userRoles,
  users,
  verificationDocuments,
} from "../../config/schema";
import type {
  AccountStatus,
  AuthenticatedAdmin,
  BookingStatus,
  CenterListingStatus,
  IncidentStatus,
} from "../../lib/admin/types";
import { ALLOWED_BOOKING_TRANSITIONS } from "../../lib/admin/validation";
import { AdminAuthError } from "./admin-auth.service";
import { recordAdminAuditLog } from "./audit.service";

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

  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.id, params.userId))
    .limit(1);

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

  const now = new Date();
  const isSuspending = params.status !== "ACTIVE";

  const [updated] = await db
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
  await db
    .update(userRoles)
    .set({ isActive: params.status === "ACTIVE" })
    .where(eq(userRoles.userId, target.id));

  // If suspending an admin account, also revoke their active sessions & admin profile approval
  if (isSuspending && (target.role === "ADMIN" || target.role === "SUPER_ADMIN")) {
    await db
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

    await db
      .update(adminProfiles)
      .set({ isApproved: false, updatedAt: now })
      .where(eq(adminProfiles.userId, target.id));
  } else if (
    params.status === "ACTIVE" &&
    (target.role === "ADMIN" || target.role === "SUPER_ADMIN")
  ) {
    await db
      .update(adminProfiles)
      .set({ isApproved: true, updatedAt: now })
      .where(eq(adminProfiles.userId, target.id));
  }

  await recordAdminAuditLog({
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
  });

  return {
    id: updated.id,
    email: updated.email,
    name: updated.name,
    role: updated.role,
    status: updated.status,
    suspendedReason: updated.suspendedReason,
    updatedAt: updated.updatedAt.toISOString(),
  };
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

export async function listAdminVerifications(filters: {
  status?: string;
  search?: string;
}) {

  const [verificationsRows, allProviders, allCenters, allDocs, allUsers] =
    await Promise.all([
      db
        .select()
        .from(providerVerifications)
        .orderBy(desc(providerVerifications.submittedAt)),
      db.select().from(providers),
      db.select().from(centers),
      db.select().from(verificationDocuments),
      db.select().from(users),
    ]);

  const providerMap = new Map(allProviders.map((p) => [p.id, p]));
  const userMap = new Map(allUsers.map((u) => [u.id, u]));
  const search = (filters.search || "").trim().toLowerCase();

  return verificationsRows
    .map((v) => {
      const prov = providerMap.get(v.providerId);
      const provCenters = allCenters.filter(
        (c) => c.providerId === v.providerId
      );
      const provDocs = allDocs.filter((d) => d.providerId === v.providerId);
      const reviewer = v.reviewerId ? userMap.get(v.reviewerId) : null;

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
        reviewComments: v.reviewComments,
        rejectionReason: v.rejectionReason,
        requestedDocuments: v.requestedDocuments ?? [],
        checklistState: v.checklistState ?? {},
        centers: provCenters.map((c) => ({
          id: c.id,
          name: c.name,
          city: c.city,
          approvedCapacity: c.approvedCapacity,
          is24x7: c.is24x7,
          listingStatus: c.listingStatus,
        })),
        documents: provDocs.map((d) => ({
          id: d.id,
          documentType: d.documentType,
          documentTitle: d.documentTitle,
          mimeType: d.mimeType,
          fileSizeBytes: d.fileSizeBytes,
          status: d.status,
          checksumSha256: d.checksumSha256,
          expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
          reviewNotes: d.reviewNotes,
        })),
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
  checklistState?: Record<string, boolean>;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {

  const [verification] = await db
    .select()
    .from(providerVerifications)
    .where(eq(providerVerifications.id, params.verificationId))
    .limit(1);

  if (!verification) {
    throw new AdminAuthError(
      "VERIFICATION_NOT_FOUND",
      "Provider verification record not found.",
      404
    );
  }

  const [provider] = await db
    .select()
    .from(providers)
    .where(eq(providers.id, verification.providerId))
    .limit(1);

  if (!provider) {
    throw new AdminAuthError(
      "PROVIDER_NOT_FOUND",
      "Associated provider not found.",
      404
    );
  }

  // Prevent self-approval if an admin happens to own the provider record
  if (provider.ownerUserId === params.admin.id) {
    throw new AdminAuthError(
      "SELF_APPROVAL_FORBIDDEN",
      "A provider owner cannot self-approve their own verification.",
      403
    );
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 365 * 86_400_000);

  await db
    .update(providerVerifications)
    .set({
      status: "APPROVED",
      reviewerId: params.admin.id,
      reviewedAt: now,
      reviewComments: params.reviewComments,
      rejectionReason: null,
      requestedDocuments: [],
      checklistState: params.checklistState ?? {
        licenseVerified: true,
        backgroundChecksVerified: true,
        facilitySafetyVerified: true,
        insuranceVerified: true,
      },
      expiresAt,
      updatedAt: now,
    })
    .where(eq(providerVerifications.id, verification.id));

  await db
    .update(providers)
    .set({
      verificationStatus: "APPROVED",
      isPublished: true,
      updatedAt: now,
    })
    .where(eq(providers.id, provider.id));

  await db
    .update(centers)
    .set({
      verificationStatus: "APPROVED",
      listingStatus: "ACTIVE",
      updatedAt: now,
    })
    .where(eq(centers.providerId, provider.id));

  await db
    .update(verificationDocuments)
    .set({
      status: "VERIFIED",
      reviewedBy: params.admin.id,
      reviewedAt: now,
      reviewNotes: params.reviewComments,
    })
    .where(eq(verificationDocuments.providerId, provider.id));

  await recordAdminAuditLog({
    adminUserId: params.admin.id,
    adminEmail: params.admin.email,
    action: "PROVIDER_VERIFICATION_APPROVED",
    entityType: "PROVIDER_VERIFICATION",
    entityId: verification.id,
    summary: `Approved verification for ${provider.organizationName}. Comments: ${params.reviewComments}`,
    previousState: {
      status: verification.status,
      isPublished: provider.isPublished,
    },
    newState: { status: "APPROVED", isPublished: true },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });

  return {
    verificationId: verification.id,
    providerId: provider.id,
    status: "APPROVED" as const,
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

  const [verification] = await db
    .select()
    .from(providerVerifications)
    .where(eq(providerVerifications.id, params.verificationId))
    .limit(1);

  if (!verification) {
    throw new AdminAuthError(
      "VERIFICATION_NOT_FOUND",
      "Provider verification record not found.",
      404
    );
  }

  const [provider] = await db
    .select()
    .from(providers)
    .where(eq(providers.id, verification.providerId))
    .limit(1);

  if (!provider) {
    throw new AdminAuthError(
      "PROVIDER_NOT_FOUND",
      "Associated provider not found.",
      404
    );
  }

  const now = new Date();
  const nextStatus = params.suspendProvider ? "SUSPENDED" : "REJECTED";

  await db
    .update(providerVerifications)
    .set({
      status: nextStatus,
      reviewerId: params.admin.id,
      reviewedAt: now,
      rejectionReason: params.rejectionReason,
      reviewComments: params.reviewComments ?? params.rejectionReason,
      updatedAt: now,
    })
    .where(eq(providerVerifications.id, verification.id));

  await db
    .update(providers)
    .set({
      verificationStatus: nextStatus,
      isPublished: false,
      updatedAt: now,
    })
    .where(eq(providers.id, provider.id));

  await db
    .update(centers)
    .set({
      verificationStatus: nextStatus,
      listingStatus: params.suspendProvider ? "SUSPENDED" : "INACTIVE",
      suspendedReason: params.rejectionReason,
      updatedAt: now,
    })
    .where(eq(centers.providerId, provider.id));

  await recordAdminAuditLog({
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
  });

  return {
    verificationId: verification.id,
    providerId: provider.id,
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

  const [verification] = await db
    .select()
    .from(providerVerifications)
    .where(eq(providerVerifications.id, params.verificationId))
    .limit(1);

  if (!verification) {
    throw new AdminAuthError(
      "VERIFICATION_NOT_FOUND",
      "Provider verification record not found.",
      404
    );
  }

  const [provider] = await db
    .select()
    .from(providers)
    .where(eq(providers.id, verification.providerId))
    .limit(1);

  if (!provider) {
    throw new AdminAuthError(
      "PROVIDER_NOT_FOUND",
      "Associated provider not found.",
      404
    );
  }

  const now = new Date();

  await db
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

  await db
    .update(providers)
    .set({
      verificationStatus: "UNDER_REVIEW",
      isPublished: false,
      updatedAt: now,
    })
    .where(eq(providers.id, provider.id));

  await recordAdminAuditLog({
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
  });

  return {
    verificationId: verification.id,
    providerId: provider.id,
    status: "UNDER_REVIEW" as const,
    requestedDocuments: params.requestedDocuments,
    reviewComments: params.reviewComments,
    reviewedBy: params.admin.email,
    reviewedAt: now.toISOString(),
  };
}

// ==========================================
// 3. Daycare Centre Management
// ==========================================

export async function listAdminCenters(filters: {
  search?: string;
  listingStatus?: string;
  verificationStatus?: string;
  city?: string;
}) {

  const [allCenters, allProviders, allCaregivers, allIncidents] =
    await Promise.all([
      db.select().from(centers).orderBy(desc(centers.createdAt)),
      db.select().from(providers),
      db.select().from(caregivers),
      db.select().from(safetyIncidents),
    ]);

  const providerMap = new Map(allProviders.map((p) => [p.id, p]));
  const search = (filters.search || "").trim().toLowerCase();

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
      const centerIncidents = allIncidents.filter(
        (inc) => inc.centerId === c.id
      );

      return {
        id: c.id,
        providerId: c.providerId,
        providerName: prov?.organizationName ?? "Unknown Provider",
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
        rating: c.rating,
        caregiversCount: centerCaregivers.length,
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

  const [providerRows, centerCaregivers, rules, centerIncidents, centerBookings] =
    await Promise.all([
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
    ]);

  const provider = providerRows[0] ?? null;

  return {
    ...center,
    createdAt: center.createdAt.toISOString(),
    updatedAt: center.updatedAt.toISOString(),
    provider: provider
      ? {
          id: provider.id,
          organizationName: provider.organizationName,
          registrationNumber: provider.registrationNumber,
          verificationStatus: provider.verificationStatus,
        }
      : null,
    caregivers: centerCaregivers.map((cg) => ({
      id: cg.id,
      fullName: cg.fullName,
      email: cg.email,
      phone: cg.phone,
      roleTitle: cg.roleTitle,
      certifications: cg.certifications,
      backgroundCheckStatus: cg.backgroundCheckStatus,
      yearsExperience: cg.yearsExperience,
      isActive: cg.isActive,
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

  const [center] = await db
    .select()
    .from(centers)
    .where(eq(centers.id, params.centerId))
    .limit(1);

  if (!center) {
    throw new AdminAuthError(
      "CENTER_NOT_FOUND",
      "Daycare centre not found.",
      404
    );
  }

  if (
    params.listingStatus === "ACTIVE" &&
    center.verificationStatus !== "APPROVED"
  ) {
    throw new AdminAuthError(
      "CENTER_UNVERIFIED",
      "Cannot publicly activate a centre listing until its provider verification status is APPROVED.",
      400
    );
  }

  // Check active bookings so administrative actions never silently corrupt existing bookings
  const existingBookings = await db
    .select()
    .from(bookings)
    .where(eq(bookings.centerId, center.id));

  const activeBookings = existingBookings.filter((b) =>
    ["CONFIRMED", "CHECKED_IN"].includes(b.status)
  );

  const now = new Date();
  const [updated] = await db
    .update(centers)
    .set({
      listingStatus: params.listingStatus,
      suspendedReason:
        params.listingStatus === "SUSPENDED" ? params.reason : null,
      updatedAt: now,
    })
    .where(eq(centers.id, center.id))
    .returning();

  await recordAdminAuditLog({
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
  });

  return {
    id: updated.id,
    name: updated.name,
    listingStatus: updated.listingStatus,
    suspendedReason: updated.suspendedReason,
    preservedActiveBookingsCount: activeBookings.length,
    updatedAt: updated.updatedAt.toISOString(),
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

  const [booking] = await db
    .select()
    .from(bookings)
    .where(eq(bookings.id, params.bookingId))
    .limit(1);

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

  const [center] = await db
    .select()
    .from(centers)
    .where(eq(centers.id, booking.centerId))
    .limit(1);

  if (!center) {
    throw new AdminAuthError("CENTER_NOT_FOUND", "Centre not found.", 404);
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
  await db
    .update(bookings)
    .set({
      status: params.toStatus,
      cancellationReason:
        params.toStatus === "CANCELLED" || params.toStatus === "REJECTED"
          ? params.reason
          : booking.cancellationReason,
      updatedAt: now,
    })
    .where(eq(bookings.id, booking.id));

  await db.insert(bookingStatusHistory).values({
    bookingId: booking.id,
    fromStatus: booking.status,
    toStatus: params.toStatus,
    changedBy: params.admin.id,
    reason: params.reason,
    createdAt: now,
  });

  await recordAdminAuditLog({
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
  });

  return getAdminBookingById(booking.id);
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

  const [incident] = await db
    .select()
    .from(safetyIncidents)
    .where(eq(safetyIncidents.id, params.incidentId))
    .limit(1);

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

  await db
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

  await db.insert(incidentActivity).values({
    incidentId: incident.id,
    actorId: params.admin.id,
    actionType: isResolving ? "RESOLUTION_RECORDED" : "STATUS_CHANGED",
    fromStatus: incident.status,
    toStatus: params.status,
    note: params.note,
    createdAt: now,
  });

  await recordAdminAuditLog({
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
  });

  return getAdminIncidentById(incident.id);
}

export async function addAdminIncidentNote(params: {
  incidentId: string;
  note: string;
  assignedAdminId?: string;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {

  const [incident] = await db
    .select()
    .from(safetyIncidents)
    .where(eq(safetyIncidents.id, params.incidentId))
    .limit(1);

  if (!incident) {
    throw new AdminAuthError(
      "INCIDENT_NOT_FOUND",
      "Safety incident record not found.",
      404
    );
  }

  const now = new Date();

  if (params.assignedAdminId) {
    await db
      .update(safetyIncidents)
      .set({
        assignedAdminId: params.assignedAdminId,
        updatedAt: now,
      })
      .where(eq(safetyIncidents.id, incident.id));
  }

  await db.insert(incidentActivity).values({
    incidentId: incident.id,
    actorId: params.admin.id,
    actionType: params.assignedAdminId ? "ASSIGNED" : "NOTE_ADDED",
    fromStatus: incident.status,
    toStatus: incident.status,
    note: params.note,
    createdAt: now,
  });

  await recordAdminAuditLog({
    adminUserId: params.admin.id,
    adminEmail: params.admin.email,
    action: "INCIDENT_NOTE_ADDED",
    entityType: "SAFETY_INCIDENT",
    entityId: incident.id,
    summary: `Added investigation note to incident ${incident.incidentReference}`,
    newState: { note: params.note },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });

  return getAdminIncidentById(incident.id);
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
    const [existing] = await db
      .select()
      .from(platformSettings)
      .where(eq(platformSettings.settingKey, item.settingKey))
      .limit(1);

    if (existing) {
      await db
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
      await db.insert(platformSettings).values({
        settingKey: item.settingKey,
        settingValue: item.settingValue,
        category: item.category ?? "GENERAL",
        description: item.description ?? "",
        updatedByAdminId: params.admin.id,
        updatedAt: now,
      });
    }
  }

  await recordAdminAuditLog({
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
  });

  return getAdminPlatformSettings();
}
