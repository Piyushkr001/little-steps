"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  FileCheck2,
  FilePlus2,
  RefreshCw,
  Search,
  ShieldCheck,
  XCircle,
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  type AdminVerificationItem,
  verifications,
} from "@/lib/api/admin-api";
import { StatusPill } from "../_components/StatusBadges";

function VerificationsContent() {
  const searchParams = useSearchParams();
  const initialSearch = searchParams.get("search") || "";

  const [items, setItems] = useState<AdminVerificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [search, setSearch] = useState(initialSearch);
  const [statusFilter, setStatusFilter] = useState("ALL");

  const [activeItem, setActiveItem] = useState<AdminVerificationItem | null>(
    null
  );
  const [dialogMode, setDialogMode] = useState<
    "approve" | "reject" | "request-docs" | null
  >(null);
  const [comments, setComments] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [suspendAlso, setSuspendAlso] = useState(false);
  const [docRequestInput, setDocRequestInput] = useState(
    "FIRE_SAFETY_CERTIFICATE,STATE_CHILDCARE_LICENSE"
  );
  const [submitting, setSubmitting] = useState(false);

  const loadVerifications = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await verifications.list({
        status: statusFilter !== "ALL" ? statusFilter : undefined,
        search: search || undefined,
      });
      setItems(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load provider verifications."
      );
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => {
    void Promise.resolve().then(loadVerifications);
  }, [loadVerifications]);

  const handleActionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeItem || !dialogMode) return;

    setSubmitting(true);
    setError(null);
    setFeedback(null);

    try {
      if (dialogMode === "approve") {
        await verifications.approve(activeItem.id, {
          reviewComments: comments.trim(),
        });
        setFeedback(
          `Approved ${activeItem.organizationName} and activated associated centre listings.`
        );
      } else if (dialogMode === "reject") {
        await verifications.reject(activeItem.id, {
          rejectionReason: rejectionReason.trim(),
          reviewComments: comments.trim() || rejectionReason.trim(),
          suspendProvider: suspendAlso,
        });
        setFeedback(
          `${suspendAlso ? "Suspended" : "Rejected"} verification for ${activeItem.organizationName}.`
        );
      } else if (dialogMode === "request-docs") {
        const docsList = docRequestInput
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        await verifications.requestDocuments(activeItem.id, {
          requestedDocuments: docsList,
          reviewComments: comments.trim(),
        });
        setFeedback(
          `Requested additional compliance documents from ${activeItem.organizationName}.`
        );
      }

      setActiveItem(null);
      setDialogMode(null);
      setComments("");
      setRejectionReason("");
      await loadVerifications();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to process verification action."
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <CardTitle className="text-lg font-bold">
              Provider Verification & Compliance Workflow
            </CardTitle>
            <CardDescription>
              Review submitted licenses, background checks, fire safety permits,
              and approve or reject provider onboarding
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={loadVerifications}
            className="gap-1.5 rounded-full"
          >
            <RefreshCw className="size-3.5" />
            Refresh Queue
          </Button>
        </CardHeader>

        <CardContent className="space-y-4">
          {feedback && (
            <Alert className="border-teal-300 bg-[#EAF8F5] text-[#087F78] dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-200">
              <CheckCircle2 className="size-4" />
              <AlertTitle>Verification Recorded</AlertTitle>
              <AlertDescription>{feedback}</AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>Verification Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Filters */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Search by provider name, registration #, or city..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-10 rounded-xl pl-9"
              />
            </div>

            <select
              aria-label="Filter verification status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-10 rounded-xl border border-input bg-background px-3 text-xs font-medium"
            >
              <option value="ALL">All Statuses</option>
              <option value="PENDING">Pending</option>
              <option value="UNDER_REVIEW">Under Review</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </div>

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-48 w-full rounded-2xl" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-2xl border border-dashed py-12 text-center text-sm text-muted-foreground">
              No provider verification records match your current filters.
            </div>
          ) : (
            <div className="space-y-4">
              {items.map((v) => (
                <div
                  key={v.id}
                  className="flex flex-col gap-4 rounded-2xl border border-slate-200/80 bg-background p-5 shadow-2xs dark:border-border"
                >
                  <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                    <div>
                      <div className="flex flex-wrap items-center gap-2.5">
                        <h3 className="text-base font-bold text-foreground">
                          {v.organizationName}
                        </h3>
                        <StatusPill status={v.status} />
                        {v.isPublished && (
                          <span className="rounded-full bg-[#EAF8F5] px-2.5 py-0.5 text-[11px] font-semibold text-[#087F78] dark:bg-teal-950 dark:text-teal-300">
                            Publicly Verified
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Reg #{v.registrationNumber} • {v.city}, {v.state} •{" "}
                        {v.contactEmail} • Submitted{" "}
                        {new Date(v.submittedAt).toLocaleDateString()}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="xs"
                        onClick={() => {
                          setActiveItem(v);
                          setDialogMode("approve");
                          setComments(
                            "Verified childcare license, background check roster, and fire safety permit."
                          );
                        }}
                        className="gap-1 bg-[#087F78] text-white hover:bg-[#066B65]"
                      >
                        <ShieldCheck className="size-3.5" />
                        Approve
                      </Button>

                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => {
                          setActiveItem(v);
                          setDialogMode("request-docs");
                          setComments(
                            "Please upload updated municipal fire inspection certificate."
                          );
                        }}
                        className="gap-1 border-amber-300 text-amber-800 dark:text-amber-300"
                      >
                        <FilePlus2 className="size-3.5" />
                        Request Docs
                      </Button>

                      <Button
                        variant="destructive"
                        size="xs"
                        onClick={() => {
                          setActiveItem(v);
                          setDialogMode("reject");
                          setRejectionReason("");
                          setSuspendAlso(false);
                        }}
                        className="gap-1"
                      >
                        <XCircle className="size-3.5" />
                        Reject / Suspend
                      </Button>
                    </div>
                  </div>

                  {/* Submitted Documents & Centres */}
                  <div className="grid grid-cols-1 gap-4 border-t pt-3 lg:grid-cols-2">
                    <div className="space-y-2">
                      <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
                        Submitted Verification Documents ({v.documents.length})
                      </p>
                      {v.documents.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No documents attached yet.
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {v.documents.map((doc) => (
                            <div
                              key={doc.id}
                              className="flex items-center justify-between gap-2 rounded-xl border bg-muted/30 px-3 py-2 text-xs"
                            >
                              <div className="min-w-0">
                                <p className="truncate font-semibold">
                                  <FileCheck2 className="mr-1.5 inline size-3.5 text-[#087F78]" />
                                  {doc.documentTitle}
                                </p>
                                <p className="text-[11px] text-muted-foreground">
                                  {doc.documentType} •{" "}
                                  {Math.round(doc.fileSizeBytes / 1024)} KB •
                                  SHA-256:{" "}
                                  {doc.checksumSha256?.slice(0, 12) ?? "verified"}
                                  ...
                                </p>
                              </div>
                              <StatusPill status={doc.status} />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
                        Associated Daycare Centres ({v.centers.length}) & Review
                        History
                      </p>
                      <div className="space-y-1.5">
                        {v.centers.map((c) => (
                          <div
                            key={c.id}
                            className="flex items-center justify-between rounded-xl border bg-muted/30 px-3 py-2 text-xs"
                          >
                            <span>
                              <Building2 className="mr-1.5 inline size-3.5 text-[#087F78]" />
                              <strong>{c.name}</strong> ({c.city}) • Cap:{" "}
                              {c.approvedCapacity}
                            </span>
                            <StatusPill status={c.listingStatus} />
                          </div>
                        ))}
                      </div>

                      {(v.reviewComments || v.rejectionReason) && (
                        <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-2.5 text-xs dark:border-border dark:bg-muted/20">
                          {v.reviewerEmail && (
                            <p className="font-semibold text-[#087F78] dark:text-teal-300">
                              Reviewed by {v.reviewerName || v.reviewerEmail}
                            </p>
                          )}
                          {v.reviewComments && (
                            <p className="mt-0.5 text-muted-foreground">
                              {v.reviewComments}
                            </p>
                          )}
                          {v.rejectionReason && (
                            <p className="mt-1 font-medium text-rose-600">
                              Rejection Reason: {v.rejectionReason}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Action Dialog */}
      <Dialog
        open={Boolean(activeItem && dialogMode)}
        onOpenChange={(open) => {
          if (!open) {
            setActiveItem(null);
            setDialogMode(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialogMode === "approve" && "Approve Provider Verification"}
              {dialogMode === "reject" &&
                "Reject or Suspend Provider Verification"}
              {dialogMode === "request-docs" &&
                "Request Additional Documentation"}
            </DialogTitle>
            <DialogDescription>
              Provider: <strong>{activeItem?.organizationName}</strong>
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleActionSubmit} className="space-y-4">
            {dialogMode === "reject" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="rejection-reason">
                    Rejection / Suspension Reason (Required)
                  </Label>
                  <Textarea
                    id="rejection-reason"
                    required
                    minLength={5}
                    value={rejectionReason}
                    onChange={(e) => setRejectionReason(e.target.value)}
                    placeholder="Specify why the provider verification is being rejected or suspended..."
                  />
                </div>
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    checked={suspendAlso}
                    onChange={(e) => setSuspendAlso(e.target.checked)}
                    className="size-4 rounded"
                  />
                  Mark provider status as SUSPENDED (revokes existing verification)
                </label>
              </>
            )}

            {dialogMode === "request-docs" && (
              <div className="space-y-1.5">
                <Label htmlFor="req-docs">
                  Required Document Codes (Comma-separated)
                </Label>
                <Input
                  id="req-docs"
                  required
                  value={docRequestInput}
                  onChange={(e) => setDocRequestInput(e.target.value)}
                  placeholder="FIRE_SAFETY_CERTIFICATE, BACKGROUND_CHECK"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="review-comments">
                Reviewer Comments (Recorded in Audit Log)
              </Label>
              <Textarea
                id="review-comments"
                required={dialogMode !== "reject"}
                minLength={3}
                value={comments}
                onChange={(e) => setComments(e.target.value)}
                placeholder="Enter reviewer notes..."
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setActiveItem(null);
                  setDialogMode(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                className={
                  dialogMode === "reject"
                    ? "bg-rose-600 text-white hover:bg-rose-700"
                    : "bg-[#087F78] text-white hover:bg-[#066B65]"
                }
              >
                {submitting ? "Submitting..." : "Confirm Decision"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function AdminVerificationsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-2xl" />}>
      <VerificationsContent />
    </Suspense>
  );
}
