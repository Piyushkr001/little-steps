import { desc, inArray } from "drizzle-orm";
import { db } from "../../config/db";
import {
  adminAuditLogs,
  bookings,
  centers,
  notifications,
  providers,
  providerVerifications,
  safetyIncidents,
  users,
  verificationDocuments,
} from "../../config/schema";
import type {
  DashboardActivity,
  DashboardAnalytics,
  DashboardStats,
} from "../../lib/admin/types";

export async function getAdminDashboardStats(): Promise<DashboardStats> {
  const [
    allUsers,
    allProviders,
    allCenters,
    allBookings,
    allVerifications,
    allIncidents,
  ] = await Promise.all([
    db.select({ id: users.id, role: users.role }).from(users),
    db
      .select({
        id: providers.id,
        subscriptionActive: providers.subscriptionActive,
      })
      .from(providers),
    db.select({ id: centers.id }).from(centers),
    db.select({ id: bookings.id }).from(bookings),
    db
      .select({
        id: providerVerifications.id,
        status: providerVerifications.status,
      })
      .from(providerVerifications),
    db
      .select({ id: safetyIncidents.id, status: safetyIncidents.status })
      .from(safetyIncidents),
  ]);

  const totalUsers = allUsers.length;
  const totalParents = allUsers.filter((u) => u.role === "PARENT").length;
  const totalProviders = allProviders.length;
  const totalCenters = allCenters.length;
  const totalBookings = allBookings.length;
  const pendingVerifications = allVerifications.filter(
    (v) => v.status === "PENDING" || v.status === "UNDER_REVIEW"
  ).length;
  const openIncidents = allIncidents.filter(
    (i) => i.status !== "RESOLVED" && i.status !== "CLOSED"
  ).length;
  const activeSubscriptions = allProviders.filter(
    (p) => p.subscriptionActive
  ).length;

  return {
    totalUsers,
    totalParents,
    totalProviders,
    totalCenters,
    totalBookings,
    pendingVerifications,
    openIncidents,
    activeSubscriptions,
  };
}

export async function getAdminDashboardAnalytics(): Promise<DashboardAnalytics> {

  const [allUsers, allProviders, allCenters, allBookings] = await Promise.all([
    db.select().from(users),
    db.select().from(providers),
    db.select().from(centers),
    db.select().from(bookings),
  ]);

  // Build 6-month window from real createdAt timestamps
  const now = new Date();
  const monthBuckets: Array<{
    key: string;
    label: string;
    start: Date;
    end: Date;
  }> = [];

  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const next = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const label = d.toLocaleString("en-US", { month: "short" });
    monthBuckets.push({
      key: `${d.getFullYear()}-${d.getMonth()}`,
      label,
      start: d,
      end: next,
    });
  }

  const monthlyActivity = monthBuckets.map((bucket) => {
    const userRegistrations = allUsers.filter(
      (u) => u.createdAt >= bucket.start && u.createdAt < bucket.end
    ).length;
    const providerOnboarding = allProviders.filter(
      (p) => p.createdAt >= bucket.start && p.createdAt < bucket.end
    ).length;
    const monthBookings = allBookings.filter(
      (b) => b.createdAt >= bucket.start && b.createdAt < bucket.end
    ).length;
    const activeCenters = allCenters.filter(
      (c) => c.createdAt < bucket.end && c.listingStatus === "ACTIVE"
    ).length;

    return {
      month: bucket.label,
      userRegistrations,
      providerOnboarding,
      bookings: monthBookings,
      activeCenters,
    };
  });

  const statuses = [
    "REQUESTED",
    "CONFIRMED",
    "CHECKED_IN",
    "COMPLETED",
    "CANCELLED",
    "REJECTED",
    "EXPIRED",
    "NO_SHOW",
  ] as const;

  const bookingTrendsByStatus = statuses.map((status) => ({
    status,
    count: allBookings.filter((b) => b.status === status).length,
  }));

  const approved = allProviders.filter(
    (p) => p.verificationStatus === "APPROVED"
  ).length;
  const pending = allProviders.filter(
    (p) => p.verificationStatus === "PENDING"
  ).length;
  const underReview = allProviders.filter(
    (p) => p.verificationStatus === "UNDER_REVIEW"
  ).length;
  const rejected = allProviders.filter(
    (p) => p.verificationStatus === "REJECTED"
  ).length;
  const suspended = allProviders.filter(
    (p) => p.verificationStatus === "SUSPENDED"
  ).length;
  const totalReviewedOrPending = allProviders.length || 1;

  const centerCapacityUtilization = allCenters.map((c) => ({
    centerName: c.name,
    city: c.city,
    approvedCapacity: c.approvedCapacity,
    currentOccupancy: c.currentOccupancy,
    utilizationPercent:
      c.approvedCapacity > 0
        ? Math.round((c.currentOccupancy / c.approvedCapacity) * 100)
        : 0,
  }));

  return {
    monthlyActivity,
    bookingTrendsByStatus,
    providerApprovalRates: {
      approved,
      pending,
      underReview,
      rejected,
      suspended,
      approvalRatePercent: Math.round((approved / totalReviewedOrPending) * 100),
    },
    centerCapacityUtilization,
  };
}

export async function getAdminDashboardActivity(): Promise<
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
> {

  const [
    recentProvidersRows,
    verificationsRows,
    docsRows,
    recentBookingsRows,
    recentIncidentsRows,
    auditRows,
    notificationRows,
    allUsers,
    allProviders,
    allCenters,
  ] = await Promise.all([
    db.select().from(providers).orderBy(desc(providers.createdAt)).limit(6),
    db
      .select()
      .from(providerVerifications)
      .where(
        inArray(providerVerifications.status, ["PENDING", "UNDER_REVIEW"])
      )
      .orderBy(desc(providerVerifications.submittedAt))
      .limit(6),
    db
      .select({
        id: verificationDocuments.id,
        providerId: verificationDocuments.providerId,
      })
      .from(verificationDocuments),
    db.select().from(bookings).orderBy(desc(bookings.createdAt)).limit(6),
    db
      .select()
      .from(safetyIncidents)
      .orderBy(desc(safetyIncidents.occurredAt))
      .limit(6),
    db
      .select()
      .from(adminAuditLogs)
      .orderBy(desc(adminAuditLogs.createdAt))
      .limit(8),
    db
      .select()
      .from(notifications)
      .orderBy(desc(notifications.createdAt))
      .limit(8),
    db.select().from(users),
    db.select().from(providers),
    db.select().from(centers),
  ]);

  const userMap = new Map(allUsers.map((u) => [u.id, u]));
  const providerMap = new Map(allProviders.map((p) => [p.id, p]));
  const centerMap = new Map(allCenters.map((c) => [c.id, c]));

  return {
    recentProviders: recentProvidersRows.map((p) => ({
      id: p.id,
      organizationName: p.organizationName,
      city: p.city,
      state: p.state,
      verificationStatus: p.verificationStatus,
      createdAt: p.createdAt.toISOString(),
    })),
    pendingVerifications: verificationsRows.map((v) => {
      const prov = providerMap.get(v.providerId);
      const docCount = docsRows.filter(
        (d) => d.providerId === v.providerId
      ).length;
      return {
        id: v.id,
        providerId: v.providerId,
        organizationName: prov?.organizationName ?? "Unknown Provider",
        status: v.status,
        submittedAt: v.submittedAt.toISOString(),
        documentCount: docCount,
      };
    }),
    recentBookings: recentBookingsRows.map((b) => ({
      id: b.id,
      bookingReference: b.bookingReference,
      centerName: centerMap.get(b.centerId)?.name ?? "Unknown Centre",
      parentName: userMap.get(b.parentId)?.name ?? "Registered Parent",
      careType: b.careType,
      status: b.status,
      totalAmount: b.totalAmount,
      startTime: b.startTime.toISOString(),
    })),
    recentIncidents: recentIncidentsRows.map((inc) => ({
      id: inc.id,
      incidentReference: inc.incidentReference,
      title: inc.title,
      category: inc.category,
      severity: inc.severity,
      status: inc.status,
      centerName: centerMap.get(inc.centerId)?.name ?? "Unknown Centre",
      occurredAt: inc.occurredAt.toISOString(),
    })),
    recentAuditLogs: auditRows.map((log) => ({
      id: log.id,
      adminEmail: log.adminEmail,
      action: log.action,
      entityType: log.entityType,
      summary: log.summary,
      createdAt: log.createdAt.toISOString(),
    })),
    notifications: notificationRows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      message: n.message,
      isRead: n.isRead,
      createdAt: n.createdAt.toISOString(),
    })),
  };
}
