"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Building2,
  Clock,
  Eye,
  MapPin,
  RefreshCw,
  Search,
  ShieldCheck,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { CenterListingStatus } from "@/lib/admin/types";
import {
  type AdminCenterDetail,
  type AdminCenterListItem,
  centers as centersApi,
} from "@/lib/api/admin-api";
import { extractApiErrorMessage } from "@/lib/api/axios-client";
import { StatusPill } from "../_components/StatusBadges";

export default function AdminCentersPage() {
  const [items, setItems] = useState<AdminCenterListItem[]>([]);
  const [search, setSearch] = useState("");
  const [listingStatus, setListingStatus] = useState("");
  const [verificationStatus, setVerificationStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedCenter, setSelectedCenter] =
    useState<AdminCenterDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [targetCenter, setTargetCenter] = useState<AdminCenterListItem | null>(
    null
  );
  const [nextListingStatus, setNextListingStatus] =
    useState<CenterListingStatus>("SUSPENDED");
  const [statusReason, setStatusReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadCenters = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await centersApi.list({
        search: search || undefined,
        listingStatus: listingStatus || undefined,
        verificationStatus: verificationStatus || undefined,
      });
      setItems(data);
    } catch (err) {
      setError(extractApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [search, listingStatus, verificationStatus]);

  useEffect(() => {
    void Promise.resolve().then(loadCenters);
  }, [loadCenters]);

  const openCenterDetails = async (centerId: string) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setSelectedCenter(null);
    try {
      const detail = await centersApi.getById(centerId);
      setSelectedCenter(detail);
    } catch (err) {
      setError(extractApiErrorMessage(err));
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  };

  const openListingStatusModal = (
    center: AdminCenterListItem,
    status: CenterListingStatus
  ) => {
    setTargetCenter(center);
    setNextListingStatus(status);
    setStatusReason("");
    setActionError(null);
    setStatusModalOpen(true);
  };

  const handleUpdateListingStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetCenter) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await centersApi.updateStatus(targetCenter.id, {
        listingStatus: nextListingStatus,
        reason: statusReason,
      });
      setStatusModalOpen(false);
      await loadCenters();
      if (selectedCenter?.id === targetCenter.id) {
        const refreshed = await centersApi.getById(targetCenter.id);
        setSelectedCenter(refreshed);
      }
    } catch (err) {
      setActionError(extractApiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[#0B3B3C] dark:text-teal-50">
            Daycare Centre Management
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Oversee registered childcare centres, operating hours, approved
            capacity, caregiver ratios, and listing status without disrupting
            active bookings.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void loadCenters()}
          disabled={loading}
          className="rounded-xl"
        >
          <RefreshCw
            className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Refresh Centres
        </Button>
      </div>

      {/* Filters */}
      <Card className="border-slate-200/80 dark:border-slate-800">
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div className="relative md:col-span-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by centre name, city, or address..."
                className="pl-9"
              />
            </div>
            <select
              value={listingStatus}
              onChange={(e) => setListingStatus(e.target.value)}
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="">All Listing Statuses</option>
              <option value="ACTIVE">Active Listing</option>
              <option value="INACTIVE">Inactive Listing</option>
              <option value="SUSPENDED">Suspended Listing</option>
            </select>
            <select
              value={verificationStatus}
              onChange={(e) => setVerificationStatus(e.target.value)}
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="">All Verification Statuses</option>
              <option value="APPROVED">Approved</option>
              <option value="UNDER_REVIEW">Under Review</option>
              <option value="PENDING">Pending</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}

      {/* Centres Grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {loading ? (
          <Card className="col-span-full border-slate-200/80 dark:border-slate-800">
            <CardContent className="p-8 text-center text-sm text-slate-500">
              Loading daycare centres...
            </CardContent>
          </Card>
        ) : items.length === 0 ? (
          <Card className="col-span-full border-slate-200/80 dark:border-slate-800">
            <CardContent className="p-8 text-center text-sm text-slate-500">
              No daycare centres match the current filter criteria.
            </CardContent>
          </Card>
        ) : (
          items.map((center) => {
            const occupancyPct =
              center.approvedCapacity > 0
                ? Math.round(
                    (center.currentOccupancy / center.approvedCapacity) * 100
                  )
                : 0;

            return (
              <Card
                key={center.id}
                className="border-slate-200/80 shadow-xs dark:border-slate-800"
              >
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-base font-bold text-[#0B3B3C] dark:text-teal-50">
                          {center.name}
                        </CardTitle>
                        {center.is24x7 && (
                          <span className="rounded-full bg-[#EAF8F5] px-2 py-0.5 text-[10px] font-bold text-[#087F78] dark:bg-teal-950 dark:text-teal-300">
                            24×7 CARE
                          </span>
                        )}
                      </div>
                      <CardDescription className="mt-0.5 flex items-center gap-1.5 text-xs">
                        <Building2 className="h-3.5 w-3.5 text-[#087F78]" />
                        {center.providerName}
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <StatusPill status={center.verificationStatus} />
                      <StatusPill status={center.listingStatus} />
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="space-y-4 text-xs">
                  <div className="flex flex-wrap items-center gap-4 text-slate-600 dark:text-slate-400">
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3.5 w-3.5 text-slate-400" />
                      {center.address}, {center.city}, {center.state}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Users className="h-3.5 w-3.5 text-slate-400" />
                      {center.caregiversCount} Verified Caregivers
                    </span>
                  </div>

                  {/* Age groups */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium text-slate-500">
                      Age Groups:
                    </span>
                    {center.ageGroupsSupported.map((group) => (
                      <span
                        key={group}
                        className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                      >
                        {group}
                      </span>
                    ))}
                  </div>

                  {/* Approved capacity & occupancy */}
                  <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 dark:border-slate-800/80 dark:bg-slate-900/50">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="font-semibold text-slate-700 dark:text-slate-300">
                        Approved Capacity Utilization
                      </span>
                      <span className="font-bold text-[#0B3B3C] dark:text-teal-200">
                        {center.currentOccupancy} / {center.approvedCapacity}{" "}
                        children ({occupancyPct}%)
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                      <div
                        className={`h-full rounded-full ${
                          occupancyPct >= 90
                            ? "bg-rose-500"
                            : occupancyPct >= 75
                              ? "bg-amber-500"
                              : "bg-[#087F78]"
                        }`}
                        style={{ width: `${Math.min(100, occupancyPct)}%` }}
                      />
                    </div>
                  </div>

                  {center.openIncidentsCount > 0 && (
                    <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50/70 px-3 py-2 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span>
                        {center.openIncidentsCount} open safety incident(s)
                        associated with this centre
                      </span>
                    </div>
                  )}

                  {center.suspendedReason && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                      <strong>Listing Note:</strong> {center.suspendedReason}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                    <div className="text-slate-500">
                      Rates:{" "}
                      <strong className="text-slate-800 dark:text-slate-200">
                        ₹{center.hourlyRate}/hr
                      </strong>{" "}
                      ·{" "}
                      <strong className="text-slate-800 dark:text-slate-200">
                        ₹{center.dailyRate}/day
                      </strong>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => void openCenterDetails(center.id)}
                      >
                        <Eye className="mr-1 h-3.5 w-3.5" />
                        Inspect Centre
                      </Button>
                      {center.listingStatus === "ACTIVE" ? (
                        <Button
                          variant="destructive"
                          size="xs"
                          onClick={() =>
                            openListingStatusModal(center, "SUSPENDED")
                          }
                        >
                          Suspend Listing
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() =>
                            openListingStatusModal(center, "ACTIVE")
                          }
                          className="border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300"
                        >
                          Reactivate Listing
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {/* Inspect Centre Detail Dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {selectedCenter?.name ?? "Daycare Centre Details"}
            </DialogTitle>
            <DialogDescription>
              Operating hours, caregiver roster, capacity rules, and safety
              incident records.
            </DialogDescription>
          </DialogHeader>

          {detailLoading || !selectedCenter ? (
            <div className="py-8 text-center text-sm text-slate-500">
              Loading centre details...
            </div>
          ) : (
            <div className="space-y-5 text-xs">
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3.5 dark:border-slate-800 dark:bg-slate-900/50 sm:grid-cols-4">
                <div>
                  <p className="text-slate-500">Listing Status</p>
                  <div className="mt-1">
                    <StatusPill status={selectedCenter.listingStatus} />
                  </div>
                </div>
                <div>
                  <p className="text-slate-500">Verification</p>
                  <div className="mt-1">
                    <StatusPill status={selectedCenter.verificationStatus} />
                  </div>
                </div>
                <div>
                  <p className="text-slate-500">Approved Capacity</p>
                  <p className="mt-1 text-sm font-bold text-slate-900 dark:text-white">
                    {selectedCenter.currentOccupancy} /{" "}
                    {selectedCenter.approvedCapacity}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">Active Bookings</p>
                  <p className="mt-1 text-sm font-bold text-[#087F78]">
                    {selectedCenter.activeBookingsCount} preserved
                  </p>
                </div>
              </div>

              {/* Operating Hours */}
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-200">
                  <Clock className="h-4 w-4 text-[#087F78]" />
                  Declared Operating Hours
                </h4>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {Object.entries(selectedCenter.operatingHours || {}).map(
                    ([day, hrs]) => (
                      <div
                        key={day}
                        className="rounded-lg border border-slate-200/80 px-2.5 py-2 dark:border-slate-800"
                      >
                        <p className="font-semibold capitalize text-slate-700 dark:text-slate-300">
                          {day}
                        </p>
                        <p className="text-slate-500">
                          {hrs.is24Hours
                            ? "Open 24 Hours"
                            : `${hrs.open} – ${hrs.close}`}
                        </p>
                      </div>
                    )
                  )}
                </div>
              </div>

              {/* Capacity Rules */}
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-200">
                  <ShieldCheck className="h-4 w-4 text-[#087F78]" />
                  Age-Group Capacity & Caregiver Ratio Rules
                </h4>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {selectedCenter.capacityRules.map((rule) => (
                    <div
                      key={rule.id}
                      className="flex items-center justify-between rounded-lg border border-slate-200/80 px-3 py-2 dark:border-slate-800"
                    >
                      <div>
                        <p className="font-semibold text-slate-800 dark:text-slate-200">
                          {rule.ageGroup}
                        </p>
                        <p className="text-slate-500">
                          Max {rule.maxChildren} children
                        </p>
                      </div>
                      <span className="rounded-md bg-[#EAF8F5] px-2 py-1 font-bold text-[#087F78] dark:bg-teal-950 dark:text-teal-300">
                        Ratio {rule.caregiverRatio}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Associated Caregivers */}
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-200">
                  <Users className="h-4 w-4 text-[#087F78]" />
                  Associated Caregivers ({selectedCenter.caregivers.length})
                </h4>
                <div className="space-y-2">
                  {selectedCenter.caregivers.map((cg) => (
                    <div
                      key={cg.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200/80 px-3 py-2 dark:border-slate-800"
                    >
                      <div>
                        <p className="font-semibold text-slate-800 dark:text-slate-200">
                          {cg.fullName} ·{" "}
                          <span className="font-normal text-slate-500">
                            {cg.roleTitle} ({cg.yearsExperience} yrs exp)
                          </span>
                        </p>
                        <p className="text-slate-500">
                          Certifications: {cg.certifications.join(", ")}
                        </p>
                      </div>
                      <StatusPill status={cg.backgroundCheckStatus} />
                    </div>
                  ))}
                </div>
              </div>

              {/* Centre-Related Incidents */}
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-200">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  Centre-Related Safety Incidents (
                  {selectedCenter.incidents.length})
                </h4>
                {selectedCenter.incidents.length === 0 ? (
                  <p className="text-slate-500">
                    No safety incidents reported for this centre.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {selectedCenter.incidents.map((inc) => (
                      <div
                        key={inc.id}
                        className="flex items-center justify-between rounded-lg border border-slate-200/80 px-3 py-2 dark:border-slate-800"
                      >
                        <div>
                          <p className="font-semibold text-slate-800 dark:text-slate-200">
                            {inc.incidentReference}: {inc.title}
                          </p>
                          <p className="text-slate-500">
                            Category: {inc.category}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <StatusPill status={inc.severity} />
                          <StatusPill status={inc.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Update Listing Status Modal */}
      <Dialog open={statusModalOpen} onOpenChange={setStatusModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {nextListingStatus === "SUSPENDED"
                ? "Suspend Daycare Centre Listing"
                : "Reactivate Daycare Centre Listing"}
            </DialogTitle>
            <DialogDescription>
              Updating listing status for{" "}
              <strong>{targetCenter?.name}</strong>. Existing confirmed and
              checked-in bookings are never silently corrupted.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleUpdateListingStatus} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="center-status-select">Target Listing Status</Label>
              <select
                id="center-status-select"
                value={nextListingStatus}
                onChange={(e) =>
                  setNextListingStatus(e.target.value as CenterListingStatus)
                }
                className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-800 dark:bg-slate-900"
              >
                <option value="ACTIVE">ACTIVE (Publicly bookable)</option>
                <option value="INACTIVE">INACTIVE (Paused new bookings)</option>
                <option value="SUSPENDED">
                  SUSPENDED (Compliance hold)
                </option>
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="center-reason">
                Administrative Reason (Recorded in Audit Log)
              </Label>
              <Textarea
                id="center-reason"
                value={statusReason}
                onChange={(e) => setStatusReason(e.target.value)}
                placeholder="Provide a clear operational or compliance justification..."
                required
                minLength={5}
              />
            </div>

            {actionError && (
              <p className="text-xs font-medium text-rose-600">{actionError}</p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setStatusModalOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting || statusReason.trim().length < 5}
                className="bg-[#087F78] text-white hover:bg-[#06655F]"
              >
                {submitting ? "Saving..." : "Confirm Status Change"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
