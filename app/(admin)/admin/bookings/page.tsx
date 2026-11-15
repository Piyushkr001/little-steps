"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Eye,
  History,
  RefreshCw,
  Search,
  ShieldAlert,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { BookingStatus } from "@/lib/admin/types";
import {
  type AdminBookingDetail,
  type AdminBookingListItem,
  bookings as bookingsApi,
} from "@/lib/api/admin-api";
import { extractApiErrorMessage } from "@/lib/api/axios-client";
import { StatusPill } from "../_components/StatusBadges";

export default function AdminBookingsPage() {
  const [items, setItems] = useState<AdminBookingListItem[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedBooking, setSelectedBooking] =
    useState<AdminBookingDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [nextStatus, setNextStatus] = useState<BookingStatus | "">("");
  const [transitionReason, setTransitionReason] = useState("");
  const [transitionSubmitting, setTransitionSubmitting] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  const loadBookings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await bookingsApi.list({
        search: search || undefined,
        status: statusFilter || undefined,
      });
      setItems(data);
    } catch (err) {
      setError(extractApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => {
    void Promise.resolve().then(loadBookings);
  }, [loadBookings]);

  const openBookingDetail = async (id: string) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setSelectedBooking(null);
    setTransitionError(null);
    setTransitionReason("");
    try {
      const detail = await bookingsApi.getById(id);
      setSelectedBooking(detail);
      setNextStatus(
        (detail.allowedTransitions[0] as BookingStatus | undefined) ?? ""
      );
    } catch (err) {
      setError(extractApiErrorMessage(err));
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleTransitionStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBooking || !nextStatus) return;
    setTransitionSubmitting(true);
    setTransitionError(null);
    try {
      const updated = await bookingsApi.transitionStatus(selectedBooking.id, {
        status: nextStatus,
        reason: transitionReason,
      });
      setSelectedBooking(updated);
      setNextStatus(
        (updated.allowedTransitions[0] as BookingStatus | undefined) ?? ""
      );
      setTransitionReason("");
      await loadBookings();
    } catch (err) {
      setTransitionError(extractApiErrorMessage(err));
    } finally {
      setTransitionSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[#0B3B3C] dark:text-teal-50">
            Booking & Dispute Oversight
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Monitor childcare reservations, review cancellations and disputes,
            inspect status history, and enforce capacity constraints.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void loadBookings()}
          disabled={loading}
          className="rounded-xl"
        >
          <RefreshCw
            className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Refresh Bookings
        </Button>
      </div>

      {/* Search & Status Filters */}
      <Card className="border-slate-200/80 dark:border-slate-800">
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="relative md:col-span-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by booking reference (e.g. BK-LS-2026-001), parent, or centre..."
                className="pl-9"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="">All Booking Statuses</option>
              <option value="REQUESTED">REQUESTED</option>
              <option value="CONFIRMED">CONFIRMED</option>
              <option value="CHECKED_IN">CHECKED IN</option>
              <option value="COMPLETED">COMPLETED</option>
              <option value="CANCELLED">CANCELLED</option>
              <option value="REJECTED">REJECTED</option>
              <option value="EXPIRED">EXPIRED</option>
              <option value="NO_SHOW">NO SHOW</option>
            </select>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}

      <Card className="border-slate-200/80 shadow-xs dark:border-slate-800">
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-bold">
            Platform Reservations ({items.length})
          </CardTitle>
          <CardDescription>
            Explicit state transitions only. Childcare capacity constraints are
            strictly enforced on confirmation and check-in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Booking Reference</TableHead>
                <TableHead>Parent & Child Age Group</TableHead>
                <TableHead>Daycare Centre</TableHead>
                <TableHead>Schedule & Care Type</TableHead>
                <TableHead>Status & Alerts</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-8 text-center text-sm text-slate-500"
                  >
                    Loading childcare bookings...
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-8 text-center text-sm text-slate-500"
                  >
                    No bookings found matching the criteria.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((bk) => (
                  <TableRow key={bk.id}>
                    <TableCell className="font-mono text-xs font-bold text-[#0B3B3C] dark:text-teal-200">
                      {bk.bookingReference}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-slate-800 dark:text-slate-100">
                        {bk.parentName}
                      </div>
                      <div className="text-xs text-slate-500">
                        {bk.parentEmail} · Age Group: {bk.childAgeGroup}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-slate-800 dark:text-slate-100">
                        {bk.centerName}
                      </div>
                      <div className="text-xs text-slate-500">
                        Occupancy: {bk.centerOccupancy}/{bk.centerCapacity}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="font-semibold text-slate-700 dark:text-slate-300">
                        {bk.careType.replace(/_/g, " ")}
                      </div>
                      <div className="text-slate-500">
                        {new Date(bk.startTime).toLocaleDateString()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusPill status={bk.status} />
                        {bk.disputesCount > 0 && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700 dark:bg-rose-950 dark:text-rose-300">
                            <ShieldAlert className="h-3 w-3" />
                            Dispute ({bk.disputesCount})
                          </span>
                        )}
                        {(bk.hasConflict || bk.capacityWarning) && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                            <AlertTriangle className="h-3 w-3" />
                            Capacity Alert
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-bold text-slate-800 dark:text-slate-100">
                        ₹{bk.totalAmount}
                      </div>
                      <StatusPill status={bk.paymentStatus} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => void openBookingDetail(bk.id)}
                      >
                        <Eye className="mr-1 h-3.5 w-3.5" />
                        Manage
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Booking Detail & State Transition Dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-[#087F78]" />
              {selectedBooking?.bookingReference ?? "Booking Details"}
            </DialogTitle>
            <DialogDescription>
              Controlled reservation details, disputes, lifecycle history, and
              validated state transitions.
            </DialogDescription>
          </DialogHeader>

          {detailLoading || !selectedBooking ? (
            <div className="py-8 text-center text-sm text-slate-500">
              Loading reservation details...
            </div>
          ) : (
            <div className="space-y-5 text-xs">
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-900/50 sm:grid-cols-4">
                <div>
                  <p className="text-slate-500">Current Status</p>
                  <div className="mt-1">
                    <StatusPill status={selectedBooking.status} />
                  </div>
                </div>
                <div>
                  <p className="text-slate-500">Payment</p>
                  <div className="mt-1">
                    <StatusPill status={selectedBooking.paymentStatus} />
                  </div>
                </div>
                <div>
                  <p className="text-slate-500">Total Amount</p>
                  <p className="mt-1 text-sm font-bold text-slate-900 dark:text-white">
                    ₹{selectedBooking.totalAmount}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">Child Summary</p>
                  <p className="mt-1 font-semibold text-slate-800 dark:text-slate-200">
                    Initial:{" "}
                    {selectedBooking.childSummary?.displayInitial ?? "N/A"} (
                    {selectedBooking.childSummary?.ageGroup ?? "N/A"})
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200/80 p-3 dark:border-slate-800">
                  <p className="font-bold text-slate-800 dark:text-slate-200">
                    Registered Parent
                  </p>
                  <p className="mt-1 text-slate-600 dark:text-slate-400">
                    {selectedBooking.parent?.name} ·{" "}
                    {selectedBooking.parent?.email}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200/80 p-3 dark:border-slate-800">
                  <p className="font-bold text-slate-800 dark:text-slate-200">
                    Daycare Centre & Capacity
                  </p>
                  <p className="mt-1 text-slate-600 dark:text-slate-400">
                    {selectedBooking.center?.name} (
                    {selectedBooking.center?.currentOccupancy} /{" "}
                    {selectedBooking.center?.approvedCapacity} occupied)
                  </p>
                </div>
              </div>

              {/* Disputes */}
              {selectedBooking.disputes.length > 0 && (
                <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3.5 dark:border-rose-900/50 dark:bg-rose-950/30">
                  <h4 className="mb-2 flex items-center gap-1.5 font-bold text-rose-800 dark:text-rose-200">
                    <ShieldAlert className="h-4 w-4" />
                    Associated Booking Disputes (
                    {selectedBooking.disputes.length})
                  </h4>
                  <div className="space-y-2">
                    {selectedBooking.disputes.map((dsp) => (
                      <div
                        key={dsp.id}
                        className="rounded-lg bg-white/80 p-2.5 dark:bg-slate-900/70"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold">
                            {dsp.disputeReference}: {dsp.reason}
                          </span>
                          <StatusPill status={dsp.status} />
                        </div>
                        <p className="mt-1 text-slate-600 dark:text-slate-300">
                          {dsp.description}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Explicit State Transition Form */}
              <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                <h4 className="mb-2 font-bold text-slate-800 dark:text-slate-200">
                  Authorized Booking Lifecycle Transition
                </h4>
                {selectedBooking.allowedTransitions.length === 0 ? (
                  <p className="text-slate-500">
                    This booking is in a terminal state (
                    <strong>{selectedBooking.status}</strong>) and cannot be
                    transitioned further.
                  </p>
                ) : (
                  <form onSubmit={handleTransitionStatus} className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor="booking-next-status">
                          Permitted Next State
                        </Label>
                        <select
                          id="booking-next-status"
                          value={nextStatus}
                          onChange={(e) =>
                            setNextStatus(e.target.value as BookingStatus)
                          }
                          className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs dark:border-slate-800 dark:bg-slate-900"
                        >
                          {selectedBooking.allowedTransitions.map((st) => (
                            <option key={st} value={st}>
                              {selectedBooking.status} → {st}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="booking-reason">
                          Recorded Administrative Reason
                        </Label>
                        <Textarea
                          id="booking-reason"
                          value={transitionReason}
                          onChange={(e) => setTransitionReason(e.target.value)}
                          placeholder="Required justification for status transition..."
                          required
                          minLength={5}
                        />
                      </div>
                    </div>

                    {transitionError && (
                      <p className="text-xs font-medium text-rose-600">
                        {transitionError}
                      </p>
                    )}

                    <DialogFooter>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={
                          transitionSubmitting ||
                          !nextStatus ||
                          transitionReason.trim().length < 5
                        }
                        className="bg-[#087F78] text-white hover:bg-[#06655F]"
                      >
                        {transitionSubmitting
                          ? "Applying Transition..."
                          : `Transition to ${nextStatus}`}
                      </Button>
                    </DialogFooter>
                  </form>
                )}
              </div>

              {/* Status History */}
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-200">
                  <History className="h-4 w-4 text-[#087F78]" />
                  Booking Status History ({selectedBooking.history.length})
                </h4>
                <div className="space-y-2">
                  {selectedBooking.history.map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200/80 px-3 py-2 dark:border-slate-800"
                    >
                      <div>
                        <div className="flex items-center gap-1.5 font-semibold">
                          <span>{item.fromStatus ?? "INITIAL"}</span>
                          <ArrowRight className="h-3 w-3 text-slate-400" />
                          <StatusPill status={item.toStatus} />
                        </div>
                        <p className="mt-1 text-slate-600 dark:text-slate-400">
                          {item.reason}
                        </p>
                      </div>
                      <div className="text-right text-[11px] text-slate-500">
                        <div>{item.changedByName}</div>
                        <div>{new Date(item.createdAt).toLocaleString()}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
