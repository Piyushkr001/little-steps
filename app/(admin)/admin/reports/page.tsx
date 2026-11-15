"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BarChart3,
  Building2,
  CheckCircle2,
  IndianRupee,
  MapPin,
  RefreshCw,
  ShieldAlert,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  type AdminReportsSummary,
  reports as reportsApi,
} from "@/lib/api/admin-api";
import { extractApiErrorMessage } from "@/lib/api/axios-client";

export default function AdminReportsPage() {
  const [summary, setSummary] = useState<AdminReportsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await reportsApi.getSummary();
      setSummary(data);
    } catch (err) {
      setError(extractApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadReports);
  }, [loadReports]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[#0B3B3C] dark:text-teal-50">
            Platform Analytics & Operational Reports
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Real-time financial metrics, compliance ratios, regional capacity
            distribution, and user role breakdowns computed directly from
            PostgreSQL.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void loadReports()}
          disabled={loading}
          className="rounded-xl"
        >
          <RefreshCw
            className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Refresh Reports
        </Button>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}

      {loading || !summary ? (
        <Card className="border-slate-200/80 dark:border-slate-800">
          <CardContent className="p-8 text-center text-sm text-slate-500">
            Computing live platform operational reports...
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Financial & Subscription Metrics */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="border-slate-200/80 dark:border-slate-800">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Gross Booking Volume
                  </span>
                  <div className="rounded-xl bg-[#EAF8F5] p-2 text-[#087F78] dark:bg-teal-950 dark:text-teal-300">
                    <IndianRupee className="h-4 w-4" />
                  </div>
                </div>
                <p className="mt-3 text-2xl font-extrabold text-[#0B3B3C] dark:text-white">
                  ₹{summary.financialSummary.totalGrossBookingValue}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Across {summary.financialSummary.paidBookingsCount} settled
                  reservations
                </p>
              </CardContent>
            </Card>

            <Card className="border-slate-200/80 dark:border-slate-800">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Active Subscriptions
                  </span>
                  <div className="rounded-xl bg-amber-50 p-2 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                    <Building2 className="h-4 w-4" />
                  </div>
                </div>
                <p className="mt-3 text-2xl font-extrabold text-[#0B3B3C] dark:text-white">
                  {summary.financialSummary.activeProviderSubscriptions}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Active childcare provider tiers
                </p>
              </CardContent>
            </Card>

            <Card className="border-slate-200/80 dark:border-slate-800">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    24×7 Verified Centres
                  </span>
                  <div className="rounded-xl bg-emerald-50 p-2 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                    <CheckCircle2 className="h-4 w-4" />
                  </div>
                </div>
                <p className="mt-3 text-2xl font-extrabold text-[#0B3B3C] dark:text-white">
                  {summary.complianceMetrics.centers24x7Count}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Round-the-clock childcare availability
                </p>
              </CardContent>
            </Card>

            <Card className="border-slate-200/80 dark:border-slate-800">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Open Disputes & Incidents
                  </span>
                  <div className="rounded-xl bg-rose-50 p-2 text-rose-700 dark:bg-rose-950 dark:text-rose-300">
                    <ShieldAlert className="h-4 w-4" />
                  </div>
                </div>
                <p className="mt-3 text-2xl font-extrabold text-[#0B3B3C] dark:text-white">
                  {summary.financialSummary.openDisputesCount +
                    summary.complianceMetrics.openIncidentsCount}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {summary.financialSummary.openDisputesCount} disputes ·{" "}
                  {summary.complianceMetrics.openIncidentsCount} incidents
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Regional Daycare Capacity & Occupancy */}
            <Card className="border-slate-200/80 dark:border-slate-800">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-bold">
                  <MapPin className="h-4 w-4 text-[#087F78]" />
                  City-wise Daycare Capacity & Occupancy
                </CardTitle>
                <CardDescription>
                  Approved childcare capacity vs active occupancy across
                  operating cities.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {summary.cityDistribution.map((item) => {
                  const pct =
                    item.totalCapacity > 0
                      ? Math.round(
                          (item.totalOccupancy / item.totalCapacity) * 100
                        )
                      : 0;
                  return (
                    <div
                      key={item.city}
                      className="rounded-xl border border-slate-100 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-900/50"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-slate-800 dark:text-slate-100">
                          {item.city} ({item.centersCount} centre
                          {item.centersCount === 1 ? "" : "s"})
                        </span>
                        <span className="font-semibold text-[#087F78]">
                          {item.totalOccupancy} / {item.totalCapacity} slots (
                          {pct}%)
                        </span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                        <div
                          className="h-full rounded-full bg-[#087F78]"
                          style={{ width: `${Math.min(100, pct)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            {/* User Role & Compliance Breakdown */}
            <Card className="border-slate-200/80 dark:border-slate-800">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-bold">
                  <Users className="h-4 w-4 text-[#087F78]" />
                  Registered User Role & Verification Breakdown
                </CardTitle>
                <CardDescription>
                  Distribution of parents, childcare providers, and authorized
                  administrators.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  {summary.roleBreakdown.map((r) => (
                    <div
                      key={r.role}
                      className="rounded-xl border border-slate-200/80 p-3.5 dark:border-slate-800"
                    >
                      <p className="text-xs font-semibold text-slate-500">
                        {r.role.replace(/_/g, " ")}
                      </p>
                      <p className="mt-1 text-xl font-extrabold text-[#0B3B3C] dark:text-white">
                        {r.count}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="rounded-xl border border-slate-200/80 bg-[#EAF8F5]/50 p-4 text-xs dark:border-slate-800 dark:bg-teal-950/20">
                  <div className="flex items-center gap-2 font-bold text-[#0B3B3C] dark:text-teal-200">
                    <BarChart3 className="h-4 w-4 text-[#087F78]" />
                    Provider Compliance Summary
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-white p-2.5 dark:bg-slate-900">
                      <div className="text-lg font-extrabold text-[#087F78]">
                        {summary.complianceMetrics.approvedProviders}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Approved
                      </div>
                    </div>
                    <div className="rounded-lg bg-white p-2.5 dark:bg-slate-900">
                      <div className="text-lg font-extrabold text-amber-600">
                        {
                          summary.complianceMetrics
                            .pendingOrUnderReviewProviders
                        }
                      </div>
                      <div className="text-[11px] text-slate-500">
                        In Review
                      </div>
                    </div>
                    <div className="rounded-lg bg-white p-2.5 dark:bg-slate-900">
                      <div className="text-lg font-extrabold text-emerald-600">
                        {summary.complianceMetrics.resolvedIncidentsCount}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Resolved Cases
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
