"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Building2,
  CalendarCheck2,
  CheckCircle2,
  ClipboardCheck,
  CreditCard,
  FileSearch,
  RefreshCw,
  ShieldCheck,
  UserCheck,
  Users,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  DashboardActivity,
  DashboardAnalytics,
  DashboardStats,
} from "@/lib/admin/types";
import { dashboard } from "@/lib/api/admin-api";
import { StatusPill } from "../_components/StatusBadges";

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [analytics, setAnalytics] = useState<DashboardAnalytics | null>(null);
  const [activity, setActivity] = useState<DashboardActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, analyticsRes, activityRes] = await Promise.all([
        dashboard.getStats(),
        dashboard.getAnalytics(),
        dashboard.getActivity(),
      ]);
      setStats(statsRes);
      setAnalytics(analyticsRes);
      setActivity(activityRes);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load dashboard telemetry."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadDashboard);
  }, [loadDashboard]);

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, idx) => (
            <Skeleton key={idx} className="h-28 rounded-2xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Skeleton className="h-80 rounded-2xl" />
          <Skeleton className="h-80 rounded-2xl" />
        </div>
      </div>
    );
  }

  if (error || !stats || !analytics || !activity) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>Dashboard Load Error</AlertTitle>
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>{error || "Unable to fetch dashboard data."}</span>
          <Button size="sm" variant="outline" onClick={loadDashboard}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const summaryCards = [
    {
      title: "Total Registered Users",
      value: stats.totalUsers,
      subtitle: "Parents, providers & staff",
      icon: Users,
      href: "/admin/users",
      tone: "bg-[#EAF8F5] text-[#087F78]",
    },
    {
      title: "Total Parents",
      value: stats.totalParents,
      subtitle: "Active family accounts",
      icon: UserCheck,
      href: "/admin/users?role=PARENT",
      tone: "bg-[#EAF8F5] text-[#087F78]",
    },
    {
      title: "Total Childcare Providers",
      value: stats.totalProviders,
      subtitle: "Registered organizations",
      icon: ShieldCheck,
      href: "/admin/providers",
      tone: "bg-[#FFF3E6] text-[#D97724]",
    },
    {
      title: "Total Daycare Centres",
      value: stats.totalCenters,
      subtitle: "24×7 & flexible locations",
      icon: Building2,
      href: "/admin/centers",
      tone: "bg-[#EAF8F5] text-[#087F78]",
    },
    {
      title: "Total Bookings",
      value: stats.totalBookings,
      subtitle: "All childcare reservations",
      icon: CalendarCheck2,
      href: "/admin/bookings",
      tone: "bg-[#FFF3E6] text-[#D97724]",
    },
    {
      title: "Pending Provider Verifications",
      value: stats.pendingVerifications,
      subtitle: "Requires compliance review",
      icon: ClipboardCheck,
      href: "/admin/verifications",
      tone: "bg-amber-100 text-amber-800",
    },
    {
      title: "Open Safety Incidents",
      value: stats.openIncidents,
      subtitle: "Active investigations",
      icon: AlertTriangle,
      href: "/admin/incidents",
      tone: "bg-rose-100 text-rose-700",
    },
    {
      title: "Active Subscriptions",
      value: stats.activeSubscriptions,
      subtitle: "Active provider plans",
      icon: CreditCard,
      href: "/admin/reports",
      tone: "bg-[#EAF8F5] text-[#087F78]",
    },
  ];

  const maxMonthlyCount = Math.max(
    1,
    ...analytics.monthlyActivity.flatMap((m) => [
      m.userRegistrations,
      m.providerOnboarding,
      m.bookings,
      m.activeCenters,
    ])
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Header Banner */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#087F78]/20 bg-white p-5 shadow-2xs dark:border-border dark:bg-card">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-bold tracking-wider text-[#087F78] uppercase dark:text-teal-300">
            Live Platform Telemetry
          </span>
          <h2 className="text-xl font-bold text-slate-900 dark:text-foreground sm:text-2xl">
            Little Steps 24×7 Operations Overview
          </h2>
          <p className="text-xs text-slate-600 dark:text-muted-foreground sm:text-sm">
            Real-time metrics across childcare providers, centre capacity,
            verifications, and safety compliance.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            variant="outline"
            size="sm"
            onClick={loadDashboard}
            className="gap-1.5 rounded-full border-[#087F78]/40 text-[#087F78]"
          >
            <RefreshCw className="size-3.5" />
            Refresh Data
          </Button>
          <Button
            size="sm"
            nativeButton={false}
            render={<Link href="/admin/verifications" />}
            className="gap-1.5 rounded-full bg-[#087F78] text-white hover:bg-[#066B65]"
          >
            Review Verifications ({stats.pendingVerifications})
            <ArrowUpRight className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* 8 Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {summaryCards.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.title}
              href={card.href}
              className="group flex flex-col justify-between rounded-2xl border border-slate-200/80 bg-white p-5 shadow-2xs transition-all hover:-translate-y-0.5 hover:border-[#087F78]/50 hover:shadow-md dark:border-border dark:bg-card"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="text-xs font-semibold text-slate-600 dark:text-muted-foreground">
                  {card.title}
                </span>
                <div
                  className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${card.tone}`}
                >
                  <Icon className="size-5" />
                </div>
              </div>
              <div className="mt-4 flex items-baseline justify-between">
                <span className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-foreground">
                  {card.value}
                </span>
                <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-slate-500 group-hover:text-[#087F78] dark:text-muted-foreground">
                  {card.subtitle}
                  <ArrowUpRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
                </span>
              </div>
            </Link>
          );
        })}
      </div>

      {/* Analytics Row: Monthly Platform Activity + Provider Approval & Booking Trends */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Monthly Activity Bar Visualization */}
        <Card className="rounded-2xl lg:col-span-7">
          <CardHeader>
            <CardTitle className="text-base font-bold">
              Monthly Platform Activity (6-Month Window)
            </CardTitle>
            <CardDescription>
              User registrations, provider onboarding, bookings, and active
              daycare centres
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-[#087F78]" />
                Users
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-[#F2A65A]" />
                Providers
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-teal-400" />
                Bookings
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-slate-500" />
                Active Centres
              </span>
            </div>

            <div className="grid grid-cols-6 items-end gap-3 pt-4">
              {analytics.monthlyActivity.map((item) => (
                <div
                  key={item.month}
                  className="flex flex-col items-center gap-2"
                >
                  <div className="flex h-40 w-full items-end justify-center gap-1 rounded-xl bg-slate-50 p-2 dark:bg-muted/30">
                    <div
                      title={`Users: ${item.userRegistrations}`}
                      style={{
                        height: `${Math.max(12, Math.round((item.userRegistrations / maxMonthlyCount) * 100))}%`,
                      }}
                      className="w-2.5 rounded-t bg-[#087F78]"
                    />
                    <div
                      title={`Providers: ${item.providerOnboarding}`}
                      style={{
                        height: `${Math.max(12, Math.round((item.providerOnboarding / maxMonthlyCount) * 100))}%`,
                      }}
                      className="w-2.5 rounded-t bg-[#F2A65A]"
                    />
                    <div
                      title={`Bookings: ${item.bookings}`}
                      style={{
                        height: `${Math.max(12, Math.round((item.bookings / maxMonthlyCount) * 100))}%`,
                      }}
                      className="w-2.5 rounded-t bg-teal-400"
                    />
                    <div
                      title={`Active Centres: ${item.activeCenters}`}
                      style={{
                        height: `${Math.max(12, Math.round((item.activeCenters / maxMonthlyCount) * 100))}%`,
                      }}
                      className="w-2.5 rounded-t bg-slate-500"
                    />
                  </div>
                  <span className="text-xs font-semibold text-slate-600 dark:text-muted-foreground">
                    {item.month}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Provider Approval Rate & Booking Trends */}
        <Card className="rounded-2xl lg:col-span-5">
          <CardHeader>
            <CardTitle className="text-base font-bold">
              Provider Approval Rate & Booking Lifecycle
            </CardTitle>
            <CardDescription>
              Verification distribution and reservation status counts
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="rounded-xl bg-[#EAF8F5]/70 p-4 dark:bg-teal-950/30">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#087F78] dark:text-teal-300">
                  Provider Verification Approval Rate
                </span>
                <span className="text-lg font-extrabold text-[#087F78] dark:text-teal-300">
                  {analytics.providerApprovalRates.approvalRatePercent}%
                </span>
              </div>
              <Progress
                value={analytics.providerApprovalRates.approvalRatePercent}
                className="mt-2 h-2"
              />
              <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-600 dark:text-muted-foreground">
                <span>
                  Approved:{" "}
                  <strong>{analytics.providerApprovalRates.approved}</strong>
                </span>
                <span>
                  Pending:{" "}
                  <strong>{analytics.providerApprovalRates.pending}</strong>
                </span>
                <span>
                  Under Review:{" "}
                  <strong>{analytics.providerApprovalRates.underReview}</strong>
                </span>
                <span>
                  Rejected:{" "}
                  <strong>{analytics.providerApprovalRates.rejected}</strong>
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold text-slate-600 uppercase dark:text-muted-foreground">
                Booking Status Breakdown
              </p>
              <div className="grid grid-cols-2 gap-2">
                {analytics.bookingTrendsByStatus
                  .filter((b) => b.count > 0)
                  .map((b) => (
                    <div
                      key={b.status}
                      className="flex items-center justify-between rounded-xl border border-slate-200/80 px-3 py-2 text-xs dark:border-border"
                    >
                      <StatusPill status={b.status} />
                      <span className="font-bold text-slate-900 dark:text-foreground">
                        {b.count}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Active Daycare Centres Capacity Utilization */}
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base font-bold">
            Daycare Centre Capacity Utilization
          </CardTitle>
          <CardDescription>
            Real-time occupancy compared against approved childcare capacity
            limits
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {analytics.centerCapacityUtilization.map((c) => (
            <div
              key={c.centerName}
              className="flex flex-col justify-between gap-2 rounded-xl border border-slate-200/80 p-3.5 dark:border-border"
            >
              <div>
                <p className="line-clamp-1 text-sm font-bold text-slate-900 dark:text-foreground">
                  {c.centerName}
                </p>
                <p className="text-xs text-slate-500 dark:text-muted-foreground">
                  {c.city}
                </p>
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span>
                    {c.currentOccupancy} / {c.approvedCapacity} children
                  </span>
                  <span className="font-bold text-[#087F78]">
                    {c.utilizationPercent}%
                  </span>
                </div>
                <Progress value={c.utilizationPercent} className="h-2" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Recent Activity Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Pending Verifications & Newly Registered Providers */}
        <Card className="rounded-2xl">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base font-bold">
                Provider Onboarding & Verification Queue
              </CardTitle>
              <CardDescription>
                Newly registered providers and pending compliance reviews
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              nativeButton={false}
              render={<Link href="/admin/verifications" />}
              className="text-xs text-[#087F78]"
            >
              View All
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {activity.recentProviders.map((prov) => (
              <div
                key={prov.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-200/70 p-3 dark:border-border"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900 dark:text-foreground">
                    {prov.organizationName}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-muted-foreground">
                    {prov.city}, {prov.state} •{" "}
                    {new Date(prov.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <StatusPill status={prov.verificationStatus} />
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Recent Bookings & Reported Safety Incidents */}
        <Card className="rounded-2xl">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base font-bold">
                Recent Bookings & Safety Incidents
              </CardTitle>
              <CardDescription>
                Latest childcare reservations and reported centre incidents
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              nativeButton={false}
              render={<Link href="/admin/incidents" />}
              className="text-xs text-[#087F78]"
            >
              Incidents
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {activity.recentIncidents.slice(0, 2).map((inc) => (
              <div
                key={inc.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-rose-200/70 bg-rose-50/40 p-3 dark:border-rose-900/50 dark:bg-rose-950/20"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-bold text-rose-800 dark:text-rose-300">
                    [{inc.incidentReference}] {inc.title}
                  </p>
                  <p className="text-[11px] text-slate-600 dark:text-muted-foreground">
                    {inc.centerName} • Severity: {inc.severity}
                  </p>
                </div>
                <StatusPill status={inc.status} />
              </div>
            ))}

            {activity.recentBookings.slice(0, 3).map((bk) => (
              <div
                key={bk.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-200/70 p-3 dark:border-border"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900 dark:text-foreground">
                    {bk.bookingReference} • {bk.parentName}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-muted-foreground">
                    {bk.centerName} • ${bk.totalAmount} ({bk.careType})
                  </p>
                </div>
                <StatusPill status={bk.status} />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Recent Administrative Audit Trail */}
      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base font-bold">
              <FileSearch className="size-4 text-[#087F78]" />
              Recent Administrative Audit Activity
            </CardTitle>
            <CardDescription>
              Tamper-evident log of sensitive administrative actions
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href="/admin/audit-logs" />}
            className="rounded-full text-xs"
          >
            Full Audit Log
          </Button>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {activity.recentAuditLogs.map((log) => (
            <div
              key={log.id}
              className="flex flex-col justify-between gap-2 rounded-xl border border-slate-200/70 px-4 py-3 sm:flex-row sm:items-center dark:border-border"
            >
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="size-3.5 text-[#087F78]" />
                  <span className="text-xs font-bold text-slate-900 dark:text-foreground">
                    {log.action}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    by {log.adminEmail}
                  </span>
                </div>
                <p className="text-xs text-slate-600 dark:text-muted-foreground">
                  {log.summary}
                </p>
              </div>
              <span className="shrink-0 text-[11px] text-slate-400">
                {new Date(log.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
