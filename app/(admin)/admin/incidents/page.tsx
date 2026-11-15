"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertOctagon,
  Eye,
  FilePlus2,
  History,
  RefreshCw,
  Search,
  ShieldAlert,
  UserCheck,
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
import type { IncidentStatus } from "@/lib/admin/types";
import {
  type AdminIncidentDetail,
  type AdminIncidentListItem,
  incidents as incidentsApi,
} from "@/lib/api/admin-api";
import { extractApiErrorMessage } from "@/lib/api/axios-client";
import { StatusPill } from "../_components/StatusBadges";

export default function AdminIncidentsPage() {
  const [items, setItems] = useState<AdminIncidentListItem[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedIncident, setSelectedIncident] =
    useState<AdminIncidentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Investigation status form state
  const [nextStatus, setNextStatus] = useState<IncidentStatus>("INVESTIGATING");
  const [assignedAdminId, setAssignedAdminId] = useState<string>("");
  const [resolutionOutcome, setResolutionOutcome] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [statusSaving, setStatusSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Standalone investigation note form
  const [investigationNote, setInvestigationNote] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);

  const loadIncidents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await incidentsApi.list({
        search: search || undefined,
        status: statusFilter || undefined,
        severity: severityFilter || undefined,
      });
      setItems(data);
    } catch (err) {
      setError(extractApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, severityFilter]);

  useEffect(() => {
    void Promise.resolve().then(loadIncidents);
  }, [loadIncidents]);

  const openIncidentModal = async (id: string) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setSelectedIncident(null);
    setActionError(null);
    try {
      const detail = await incidentsApi.getById(id);
      setSelectedIncident(detail);
      setNextStatus(detail.status);
      setAssignedAdminId(detail.assignedAdminId ?? "");
      setResolutionOutcome(detail.resolutionOutcome ?? "");
      setStatusNote("");
      setInvestigationNote("");
    } catch (err) {
      setError(extractApiErrorMessage(err));
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleUpdateInvestigationStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedIncident) return;
    setStatusSaving(true);
    setActionError(null);
    try {
      const updated = await incidentsApi.updateStatus(selectedIncident.id, {
        status: nextStatus,
        assignedAdminId: assignedAdminId || null,
        resolutionOutcome: resolutionOutcome || undefined,
        note: statusNote,
      });
      setSelectedIncident(updated);
      setStatusNote("");
      await loadIncidents();
    } catch (err) {
      setActionError(extractApiErrorMessage(err));
    } finally {
      setStatusSaving(false);
    }
  };

  const handleAddInvestigationNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedIncident) return;
    setNoteSaving(true);
    setActionError(null);
    try {
      const updated = await incidentsApi.addNote(selectedIncident.id, {
        note: investigationNote,
        assignedAdminId: assignedAdminId || undefined,
      });
      setSelectedIncident(updated);
      setInvestigationNote("");
      await loadIncidents();
    } catch (err) {
      setActionError(extractApiErrorMessage(err));
    } finally {
      setNoteSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[#0B3B3C] dark:text-teal-50">
            Safety Incidents & Complaints
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Review reported childcare safety incidents, assign investigators,
            record investigation notes, and maintain tamper-evident audit
            trails.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void loadIncidents()}
          disabled={loading}
          className="rounded-xl"
        >
          <RefreshCw
            className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Refresh Incidents
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
                placeholder="Search by incident ref (INC-LS-...), title, or centre..."
                className="pl-9"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="">All Investigation Statuses</option>
              <option value="REPORTED">REPORTED</option>
              <option value="UNDER_REVIEW">UNDER REVIEW</option>
              <option value="INVESTIGATING">INVESTIGATING</option>
              <option value="RESOLVED">RESOLVED</option>
              <option value="CLOSED">CLOSED</option>
            </select>
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="">All Severities</option>
              <option value="CRITICAL">CRITICAL</option>
              <option value="HIGH">HIGH</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="LOW">LOW</option>
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
            Safety Incident Registry ({items.length})
          </CardTitle>
          <CardDescription>
            Sensitive child personal data is redacted from feeds and restricted
            strictly to authorized safety reviewers.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Incident Summary & Category</TableHead>
                <TableHead>Centre & Booking Ref</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Assigned Staff</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-8 text-center text-sm text-slate-500"
                  >
                    Loading safety incidents...
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-8 text-center text-sm text-slate-500"
                  >
                    No safety incidents match the selected filters.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((inc) => (
                  <TableRow key={inc.id}>
                    <TableCell className="font-mono text-xs font-bold text-[#0B3B3C] dark:text-teal-200">
                      {inc.incidentReference}
                    </TableCell>
                    <TableCell>
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {inc.title}
                      </div>
                      <div className="text-xs text-slate-500">
                        Category: {inc.category} · Occurred:{" "}
                        {new Date(inc.occurredAt).toLocaleDateString()}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="font-medium text-slate-800 dark:text-slate-200">
                        {inc.centerName}
                      </div>
                      <div className="text-slate-500">
                        Booking: {inc.bookingReference ?? "Unlinked"}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusPill status={inc.severity} />
                    </TableCell>
                    <TableCell>
                      <StatusPill status={inc.status} />
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="inline-flex items-center gap-1 font-medium text-slate-700 dark:text-slate-300">
                        <UserCheck className="h-3.5 w-3.5 text-[#087F78]" />
                        {inc.assignedAdminName}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => void openIncidentModal(inc.id)}
                      >
                        <Eye className="mr-1 h-3.5 w-3.5" />
                        Investigate
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Investigation & Activity Modal */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertOctagon className="h-5 w-5 text-rose-600" />
              {selectedIncident?.incidentReference}: {selectedIncident?.title}
            </DialogTitle>
            <DialogDescription>
              Assign investigators, update investigation status, record
              resolution outcomes, and review immutable activity logs.
            </DialogDescription>
          </DialogHeader>

          {detailLoading || !selectedIncident ? (
            <div className="py-8 text-center text-sm text-slate-500">
              Loading safety investigation case...
            </div>
          ) : (
            <div className="space-y-5 text-xs">
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-900/50 sm:grid-cols-4">
                <div>
                  <p className="text-slate-500">Severity</p>
                  <div className="mt-1">
                    <StatusPill status={selectedIncident.severity} />
                  </div>
                </div>
                <div>
                  <p className="text-slate-500">Current Status</p>
                  <div className="mt-1">
                    <StatusPill status={selectedIncident.status} />
                  </div>
                </div>
                <div>
                  <p className="text-slate-500">Daycare Centre</p>
                  <p className="mt-1 font-bold text-slate-900 dark:text-white">
                    {selectedIncident.centerName}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">Booking Reference</p>
                  <p className="mt-1 font-mono font-bold text-[#087F78]">
                    {selectedIncident.bookingReference ?? "N/A"}
                  </p>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200/80 p-3.5 dark:border-slate-800">
                <p className="font-bold text-slate-800 dark:text-slate-200">
                  Reported Incident Description
                </p>
                <p className="mt-1 leading-relaxed text-slate-600 dark:text-slate-300">
                  {selectedIncident.description}
                </p>
                {selectedIncident.resolutionOutcome && (
                  <div className="mt-3 rounded-lg bg-emerald-50/80 p-2.5 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
                    <strong>Resolution Outcome:</strong>{" "}
                    {selectedIncident.resolutionOutcome}
                  </div>
                )}
              </div>

              {actionError && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-700">
                  {actionError}
                </div>
              )}

              {/* Update Investigation Status & Staff Assignment */}
              <form
                onSubmit={handleUpdateInvestigationStatus}
                className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800"
              >
                <h4 className="flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-200">
                  <ShieldAlert className="h-4 w-4 text-[#087F78]" />
                  Update Investigation Status & Assignment
                </h4>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="inc-status">Investigation Status</Label>
                    <select
                      id="inc-status"
                      value={nextStatus}
                      onChange={(e) =>
                        setNextStatus(e.target.value as IncidentStatus)
                      }
                      className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs dark:border-slate-800 dark:bg-slate-900"
                    >
                      <option value="REPORTED">REPORTED</option>
                      <option value="UNDER_REVIEW">UNDER REVIEW</option>
                      <option value="INVESTIGATING">INVESTIGATING</option>
                      <option value="RESOLVED">RESOLVED</option>
                      <option value="CLOSED">CLOSED</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="inc-assignee">
                      Assign to Authorized Administrator
                    </Label>
                    <select
                      id="inc-assignee"
                      value={assignedAdminId}
                      onChange={(e) => setAssignedAdminId(e.target.value)}
                      className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs dark:border-slate-800 dark:bg-slate-900"
                    >
                      <option value="">Unassigned</option>
                      {selectedIncident.availableAdmins.map((adm) => (
                        <option key={adm.id} value={adm.id}>
                          {adm.name} ({adm.email})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {(nextStatus === "RESOLVED" || nextStatus === "CLOSED") && (
                  <div className="space-y-1">
                    <Label htmlFor="inc-outcome">Resolution Outcome</Label>
                    <Input
                      id="inc-outcome"
                      value={resolutionOutcome}
                      onChange={(e) => setResolutionOutcome(e.target.value)}
                      placeholder="Summarize corrective actions and resolution outcome..."
                      required
                    />
                  </div>
                )}

                <div className="space-y-1">
                  <Label htmlFor="inc-status-note">
                    Status Update Note (Required)
                  </Label>
                  <Textarea
                    id="inc-status-note"
                    value={statusNote}
                    onChange={(e) => setStatusNote(e.target.value)}
                    placeholder="Document investigation findings or reason for status change..."
                    required
                    minLength={5}
                  />
                </div>

                <DialogFooter>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={statusSaving || statusNote.trim().length < 5}
                    className="bg-[#087F78] text-white hover:bg-[#06655F]"
                  >
                    {statusSaving ? "Updating..." : "Save Investigation Update"}
                  </Button>
                </DialogFooter>
              </form>

              {/* Quick Append Investigation Note */}
              <form
                onSubmit={handleAddInvestigationNote}
                className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800"
              >
                <h4 className="flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-200">
                  <FilePlus2 className="h-4 w-4 text-[#087F78]" />
                  Append Standalone Investigation Note
                </h4>
                <Textarea
                  value={investigationNote}
                  onChange={(e) => setInvestigationNote(e.target.value)}
                  placeholder="Add an interview log, CCTV review summary, or follow-up note..."
                  required
                  minLength={5}
                />
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    variant="outline"
                    size="sm"
                    disabled={noteSaving || investigationNote.trim().length < 5}
                  >
                    {noteSaving ? "Recording..." : "Record Note"}
                  </Button>
                </div>
              </form>

              {/* Complete Activity History */}
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-200">
                  <History className="h-4 w-4 text-[#087F78]" />
                  Complete Investigation Activity History (
                  {selectedIncident.activities.length})
                </h4>
                <div className="space-y-2">
                  {selectedIncident.activities.map((act) => (
                    <div
                      key={act.id}
                      className="rounded-lg border border-slate-200/80 px-3 py-2.5 dark:border-slate-800"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-800 dark:text-slate-200">
                          {act.actionType.replace(/_/g, " ")}
                          {act.toStatus ? ` → ${act.toStatus}` : ""}
                        </span>
                        <span className="text-[11px] text-slate-500">
                          {act.actorName} ·{" "}
                          {new Date(act.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <p className="mt-1 text-slate-600 dark:text-slate-400">
                        {act.note}
                      </p>
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
