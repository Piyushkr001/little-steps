"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ClipboardCheck,
  FileCheck2,
  FilePlus2,
  History,
  RefreshCw,
  Search,
  ShieldCheck,
  UserCheck,
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
  type AdminCaregiverVerificationItem,
  type AdminCenterVerificationItem,
  type AdminVerificationDocumentItem,
  type AdminVerificationItem,
  caregiverVerifications,
  centerVerifications,
  verificationDocuments,
  verifications,
} from "@/lib/api/admin-api";
import { extractApiErrorMessage } from "@/lib/api/axios-client";
import { StatusPill } from "../_components/StatusBadges";

type VerificationTab = "PROVIDERS" | "CENTERS" | "CAREGIVERS" | "DOCUMENTS";

function VerificationsContent() {
  const searchParams = useSearchParams();
  const initialSearch = searchParams.get("search") || "";

  const [activeTab, setActiveTab] = useState<VerificationTab>("PROVIDERS");
  const [providerItems, setProviderItems] = useState<AdminVerificationItem[]>(
    []
  );
  const [centerItems, setCenterItems] = useState<
    AdminCenterVerificationItem[]
  >([]);
  const [caregiverItems, setCaregiverItems] = useState<
    AdminCaregiverVerificationItem[]
  >([]);
  const [documentItems, setDocumentItems] = useState<
    AdminVerificationDocumentItem[]
  >([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [search, setSearch] = useState(initialSearch);
  const [statusFilter, setStatusFilter] = useState("ALL");

  // Provider dialog state
  const [activeProvider, setActiveProvider] =
    useState<AdminVerificationItem | null>(null);
  const [providerDialogMode, setProviderDialogMode] = useState<
    "approve" | "reject" | "request-docs" | null
  >(null);
  const [providerChecklist, setProviderChecklist] = useState({
    licenseVerified: true,
    organizationDetailsVerified: true,
  });

  // Center dialog state
  const [activeCenter, setActiveCenter] =
    useState<AdminCenterVerificationItem | null>(null);
  const [centerDialogMode, setCenterDialogMode] = useState<
    "approve" | "reject" | "request-docs" | null
  >(null);
  const [centerChecklist, setCenterChecklist] = useState({
    operatingLicenseVerified: true,
    facilitySafetyVerified: true,
    caregiverQualificationVerified: true,
    capacityVerified: true,
  });

  // Caregiver dialog state
  const [activeCaregiver, setActiveCaregiver] =
    useState<AdminCaregiverVerificationItem | null>(null);
  const [caregiverDialogMode, setCaregiverDialogMode] = useState<
    "approve" | "reject" | null
  >(null);

  // Document dialog state
  const [activeDocument, setActiveDocument] =
    useState<AdminVerificationDocumentItem | null>(null);
  const [documentDialogMode, setDocumentDialogMode] = useState<
    "approve" | "reject" | null
  >(null);
  const [replacementRequested, setReplacementRequested] = useState(true);

  // Shared modal fields
  const [comments, setComments] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [suspendAlso, setSuspendAlso] = useState(false);
  const [docRequestInput, setDocRequestInput] = useState(
    "FIRE_SAFETY_CERTIFICATE,STATE_CHILDCARE_LICENSE"
  );
  const [submitting, setSubmitting] = useState(false);

  const loadAllQueues = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const statusParam = statusFilter !== "ALL" ? statusFilter : undefined;
      const searchParam = search || undefined;
      const [provData, cenData, cgData, docData] = await Promise.all([
        verifications.list({ status: statusParam, search: searchParam }),
        centerVerifications.list({ status: statusParam, search: searchParam }),
        caregiverVerifications.list({
          status: statusParam,
          search: searchParam,
        }),
        verificationDocuments.list({
          status: statusParam,
          search: searchParam,
        }),
      ]);
      setProviderItems(provData);
      setCenterItems(cenData);
      setCaregiverItems(cgData);
      setDocumentItems(docData);
    } catch (err) {
      setError(extractApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => {
    void Promise.resolve().then(loadAllQueues);
  }, [loadAllQueues]);

  const handleQuickApproveDocument = async (
    doc: AdminVerificationDocumentItem
  ) => {
    setSubmitting(true);
    setError(null);
    setFeedback(null);
    try {
      await verificationDocuments.approve(doc.id, {
        reviewComments: `Individually verified ${doc.documentTitle} (${doc.documentType}).`,
      });
      setFeedback(`Verified document "${doc.documentTitle}".`);
      await loadAllQueues();
    } catch (err) {
      setError(extractApiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleProviderSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProvider || !providerDialogMode) return;
    setSubmitting(true);
    setError(null);
    setFeedback(null);
    try {
      if (providerDialogMode === "approve") {
        await verifications.approve(activeProvider.id, {
          reviewComments: comments.trim(),
          checklistState: providerChecklist,
        });
        setFeedback(
          `Approved provider organization ${activeProvider.organizationName} independently. Daycare centres and caregivers remain independently verified.`
        );
      } else if (providerDialogMode === "reject") {
        await verifications.reject(activeProvider.id, {
          rejectionReason: rejectionReason.trim(),
          reviewComments: comments.trim() || rejectionReason.trim(),
          suspendProvider: suspendAlso,
        });
        setFeedback(
          `${suspendAlso ? "Suspended" : "Rejected"} provider verification for ${activeProvider.organizationName}.`
        );
      } else if (providerDialogMode === "request-docs") {
        const docsList = docRequestInput
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        await verifications.requestDocuments(activeProvider.id, {
          requestedDocuments: docsList,
          reviewComments: comments.trim(),
        });
        setFeedback(
          `Requested additional compliance documents from ${activeProvider.organizationName}.`
        );
      }
      setActiveProvider(null);
      setProviderDialogMode(null);
      setComments("");
      setRejectionReason("");
      await loadAllQueues();
    } catch (err) {
      setError(extractApiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCenterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCenter || !centerDialogMode) return;
    setSubmitting(true);
    setError(null);
    setFeedback(null);
    try {
      if (centerDialogMode === "approve") {
        await centerVerifications.approve(activeCenter.centerId, {
          reviewComments: comments.trim(),
          checklistState: centerChecklist,
        });
        setFeedback(
          `Independently approved daycare centre ${activeCenter.centerName} and activated its listing.`
        );
      } else if (centerDialogMode === "reject") {
        await centerVerifications.reject(activeCenter.centerId, {
          rejectionReason: rejectionReason.trim(),
          reviewComments: comments.trim() || rejectionReason.trim(),
          suspendCenter: suspendAlso,
        });
        setFeedback(
          `${suspendAlso ? "Suspended" : "Rejected"} daycare centre ${activeCenter.centerName}.`
        );
      } else if (centerDialogMode === "request-docs") {
        const docsList = docRequestInput
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        await centerVerifications.requestDocuments(activeCenter.centerId, {
          requestedDocuments: docsList,
          reviewComments: comments.trim(),
        });
        setFeedback(
          `Requested additional facility documents for ${activeCenter.centerName}.`
        );
      }
      setActiveCenter(null);
      setCenterDialogMode(null);
      setComments("");
      setRejectionReason("");
      await loadAllQueues();
    } catch (err) {
      setError(extractApiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCaregiverSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCaregiver || !caregiverDialogMode) return;
    setSubmitting(true);
    setError(null);
    setFeedback(null);
    try {
      if (caregiverDialogMode === "approve") {
        await caregiverVerifications.approve(activeCaregiver.caregiverId, {
          reviewComments: comments.trim(),
          checklistState: {
            backgroundScreeningVerified: true,
            credentialsVerified: true,
          },
        });
        setFeedback(
          `Independently verified caregiver ${activeCaregiver.fullName}.`
        );
      } else if (caregiverDialogMode === "reject") {
        await caregiverVerifications.reject(activeCaregiver.caregiverId, {
          rejectionReason: rejectionReason.trim(),
          reviewComments: comments.trim() || rejectionReason.trim(),
          suspendCaregiver: suspendAlso,
        });
        setFeedback(
          `${suspendAlso ? "Suspended" : "Rejected"} caregiver ${activeCaregiver.fullName}.`
        );
      }
      setActiveCaregiver(null);
      setCaregiverDialogMode(null);
      setComments("");
      setRejectionReason("");
      await loadAllQueues();
    } catch (err) {
      setError(extractApiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDocumentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeDocument || !documentDialogMode) return;
    setSubmitting(true);
    setError(null);
    setFeedback(null);
    try {
      if (documentDialogMode === "approve") {
        await verificationDocuments.approve(activeDocument.id, {
          reviewComments: comments.trim(),
        });
        setFeedback(`Approved document "${activeDocument.documentTitle}".`);
      } else if (documentDialogMode === "reject") {
        await verificationDocuments.reject(activeDocument.id, {
          rejectionReason: rejectionReason.trim(),
          reviewComments: comments.trim() || rejectionReason.trim(),
          replacementRequested,
        });
        setFeedback(`Rejected document "${activeDocument.documentTitle}".`);
      }
      setActiveDocument(null);
      setDocumentDialogMode(null);
      setComments("");
      setRejectionReason("");
      await loadAllQueues();
    } catch (err) {
      setError(extractApiErrorMessage(err));
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
              Independent Verification & Compliance Workflow
            </CardTitle>
            <CardDescription>
              Childcare providers, daycare centres, caregivers, and compliance
              documents are independently verified before operating eligibility
              is granted.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadAllQueues()}
            className="gap-1.5 rounded-full"
          >
            <RefreshCw className="size-3.5" />
            Refresh Queues
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

          {/* Queue Tabs */}
          <div className="flex flex-wrap gap-2 border-b pb-3">
            <Button
              variant={activeTab === "PROVIDERS" ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveTab("PROVIDERS")}
              className={
                activeTab === "PROVIDERS"
                  ? "rounded-full bg-[#087F78] text-white hover:bg-[#066B65]"
                  : "rounded-full"
              }
            >
              <ShieldCheck className="mr-1.5 size-3.5" />
              Provider Organizations ({providerItems.length})
            </Button>
            <Button
              variant={activeTab === "CENTERS" ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveTab("CENTERS")}
              className={
                activeTab === "CENTERS"
                  ? "rounded-full bg-[#087F78] text-white hover:bg-[#066B65]"
                  : "rounded-full"
              }
            >
              <Building2 className="mr-1.5 size-3.5" />
              Daycare Centres ({centerItems.length})
            </Button>
            <Button
              variant={activeTab === "CAREGIVERS" ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveTab("CAREGIVERS")}
              className={
                activeTab === "CAREGIVERS"
                  ? "rounded-full bg-[#087F78] text-white hover:bg-[#066B65]"
                  : "rounded-full"
              }
            >
              <UserCheck className="mr-1.5 size-3.5" />
              Caregivers ({caregiverItems.length})
            </Button>
            <Button
              variant={activeTab === "DOCUMENTS" ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveTab("DOCUMENTS")}
              className={
                activeTab === "DOCUMENTS"
                  ? "rounded-full bg-[#087F78] text-white hover:bg-[#066B65]"
                  : "rounded-full"
              }
            >
              <FileCheck2 className="mr-1.5 size-3.5" />
              Verification Documents ({documentItems.length})
            </Button>
          </div>

          {/* Filters */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Search by provider, centre, caregiver, or document title..."
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
              <option value="VERIFIED">Verified</option>
              <option value="NOT_VERIFIED">Not Verified</option>
              <option value="SUBMITTED">Submitted</option>
              <option value="REJECTED">Rejected</option>
              <option value="SUSPENDED">Suspended</option>
              <option value="EXPIRED">Expired</option>
            </select>
          </div>

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-48 w-full rounded-2xl" />
              ))}
            </div>
          ) : activeTab === "PROVIDERS" ? (
            providerItems.length === 0 ? (
              <div className="rounded-2xl border border-dashed py-12 text-center text-sm text-muted-foreground">
                No provider verification records match your current filters.
              </div>
            ) : (
              <div className="space-y-4">
                {providerItems.map((v) => {
                  const canApprove = v.approvalEligibility?.eligible ?? true;
                  const blockingReasons =
                    v.approvalEligibility?.reasons ?? [];

                  return (
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
                            disabled={!canApprove}
                            title={
                              !canApprove
                                ? blockingReasons.join(" ")
                                : "Approve provider organization"
                            }
                            onClick={() => {
                              setActiveProvider(v);
                              setProviderDialogMode("approve");
                              setComments(
                                "Independently verified organization registration and compliance documents."
                              );
                            }}
                            className="gap-1 bg-[#087F78] text-white hover:bg-[#066B65] disabled:opacity-50"
                          >
                            <ShieldCheck className="size-3.5" />
                            Approve Provider
                          </Button>

                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => {
                              setActiveProvider(v);
                              setProviderDialogMode("request-docs");
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
                              setActiveProvider(v);
                              setProviderDialogMode("reject");
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

                      {!canApprove && blockingReasons.length > 0 && (
                        <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                          <p className="font-bold">
                            Approval Blocked — Requirements Incomplete:
                          </p>
                          <ul className="mt-1 list-disc space-y-0.5 pl-4">
                            {blockingReasons.map((reason, idx) => (
                              <li key={idx}>{reason}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="grid grid-cols-1 gap-4 border-t pt-3 lg:grid-cols-2">
                        <div className="space-y-2">
                          <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
                            Submitted Verification Documents (
                            {v.documents.length})
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
                                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/30 px-3 py-2 text-xs"
                                >
                                  <div className="min-w-0">
                                    <p className="truncate font-semibold">
                                      <FileCheck2 className="mr-1.5 inline size-3.5 text-[#087F78]" />
                                      {doc.documentTitle}
                                    </p>
                                    <p className="text-[11px] text-muted-foreground">
                                      {doc.documentType} •{" "}
                                      {Math.round(doc.fileSizeBytes / 1024)} KB
                                      • Scan: {doc.malwareScanStatus}
                                    </p>
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                    <StatusPill status={doc.status} />
                                    {doc.status !== "VERIFIED" && (
                                      <Button
                                        variant="outline"
                                        size="xs"
                                        disabled={submitting}
                                        onClick={() =>
                                          void handleQuickApproveDocument(doc)
                                        }
                                        className="h-6 px-2 text-[10px] text-[#087F78]"
                                      >
                                        Verify Doc
                                      </Button>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="space-y-2">
                          <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
                            Associated Daycare Centres ({v.centers.length}) —
                            Verified Independently
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
                                <div className="flex items-center gap-1.5">
                                  {c.verificationStatus && (
                                    <StatusPill status={c.verificationStatus} />
                                  )}
                                  <StatusPill status={c.listingStatus} />
                                </div>
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

                          {v.reviewHistory && v.reviewHistory.length > 0 && (
                            <div className="rounded-xl border border-slate-200/60 bg-slate-50/40 p-2.5 text-[11px] dark:border-border">
                              <p className="mb-1 flex items-center gap-1 font-bold text-slate-700 dark:text-slate-300">
                                <History className="size-3 text-[#087F78]" />
                                Review History ({v.reviewHistory.length})
                              </p>
                              <div className="space-y-1">
                                {v.reviewHistory.slice(0, 3).map((h) => (
                                  <p
                                    key={h.id}
                                    className="text-muted-foreground"
                                  >
                                    <strong>{h.action}</strong> (
                                    {h.previousStatus ?? "INITIAL"} →{" "}
                                    {h.newStatus}) by{" "}
                                    {h.reviewerName ||
                                      h.reviewerEmail ||
                                      "Admin"}{" "}
                                    on{" "}
                                    {new Date(h.createdAt).toLocaleDateString()}
                                  </p>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : activeTab === "CENTERS" ? (
            centerItems.length === 0 ? (
              <div className="rounded-2xl border border-dashed py-12 text-center text-sm text-muted-foreground">
                No daycare centre verification records match your current
                filters.
              </div>
            ) : (
              <div className="space-y-4">
                {centerItems.map((c) => {
                  const canApprove = c.approvalEligibility.eligible;
                  return (
                    <div
                      key={c.id}
                      className="flex flex-col gap-4 rounded-2xl border border-slate-200/80 bg-background p-5 shadow-2xs dark:border-border"
                    >
                      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-base font-bold text-foreground">
                              {c.centerName}
                            </h3>
                            <StatusPill status={c.verificationStatus} />
                            <StatusPill status={c.listingStatus} />
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Provider: <strong>{c.providerName}</strong> (
                            {c.providerVerificationStatus}) • {c.address},{" "}
                            {c.city}, {c.state} • Capacity: {c.approvedCapacity}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="xs"
                            disabled={!canApprove}
                            title={
                              !canApprove
                                ? c.approvalEligibility.reasons.join(" ")
                                : "Approve daycare centre and activate listing"
                            }
                            onClick={() => {
                              setActiveCenter(c);
                              setCenterDialogMode("approve");
                              setComments(
                                "Verified facility safety inspection, operating capacity, and qualified caregiver staffing."
                              );
                            }}
                            className="gap-1 bg-[#087F78] text-white hover:bg-[#066B65] disabled:opacity-50"
                          >
                            <ClipboardCheck className="size-3.5" />
                            Approve & Activate Centre
                          </Button>

                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => {
                              setActiveCenter(c);
                              setCenterDialogMode("request-docs");
                              setComments(
                                "Please upload updated facility safety and sanitation inspection report."
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
                              setActiveCenter(c);
                              setCenterDialogMode("reject");
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

                      {!canApprove &&
                        c.approvalEligibility.reasons.length > 0 && (
                          <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                            <p className="font-bold">
                              Centre Approval Blocked — Requirements Incomplete:
                            </p>
                            <ul className="mt-1 list-disc space-y-0.5 pl-4">
                              {c.approvalEligibility.reasons.map((r, idx) => (
                                <li key={idx}>{r}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                      <div className="grid grid-cols-1 gap-4 border-t pt-3 lg:grid-cols-2">
                        <div className="space-y-1.5">
                          <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
                            Assigned Caregivers ({c.caregivers.length} total •{" "}
                            {c.approvalEligibility.eligibleCaregiversCount}{" "}
                            verified)
                          </p>
                          {c.caregivers.map((cg) => (
                            <div
                              key={cg.id}
                              className="flex items-center justify-between rounded-xl border bg-muted/30 px-3 py-2 text-xs"
                            >
                              <span>
                                <strong>{cg.fullName}</strong> • {cg.roleTitle}
                              </span>
                              <StatusPill status={cg.backgroundCheckStatus} />
                            </div>
                          ))}
                        </div>

                        <div className="space-y-1.5">
                          <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
                            Centre Compliance Documents ({c.documents.length})
                          </p>
                          {c.documents.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              No centre-specific documents attached.
                            </p>
                          ) : (
                            c.documents.map((doc) => (
                              <div
                                key={doc.id}
                                className="flex items-center justify-between rounded-xl border bg-muted/30 px-3 py-2 text-xs"
                              >
                                <span>
                                  {doc.documentTitle} ({doc.documentType})
                                </span>
                                <StatusPill status={doc.status} />
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : activeTab === "CAREGIVERS" ? (
            caregiverItems.length === 0 ? (
              <div className="rounded-2xl border border-dashed py-12 text-center text-sm text-muted-foreground">
                No caregiver verification records match your current filters.
              </div>
            ) : (
              <div className="space-y-4">
                {caregiverItems.map((cg) => {
                  const canApprove = cg.approvalEligibility.eligible;
                  return (
                    <div
                      key={cg.id}
                      className="flex flex-col gap-4 rounded-2xl border border-slate-200/80 bg-background p-5 shadow-2xs dark:border-border"
                    >
                      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-base font-bold text-foreground">
                              {cg.fullName}
                            </h3>
                            <StatusPill status={cg.backgroundCheckStatus} />
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {cg.roleTitle} • {cg.centerName} ({cg.providerName})
                            • {cg.email} • {cg.yearsExperience} yrs experience
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Certifications:{" "}
                            {cg.certifications.join(", ") || "None listed"}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="xs"
                            disabled={!canApprove}
                            title={
                              !canApprove
                                ? cg.approvalEligibility.reasons.join(" ")
                                : "Approve caregiver background verification"
                            }
                            onClick={() => {
                              setActiveCaregiver(cg);
                              setCaregiverDialogMode("approve");
                              setComments(
                                "Verified background screening clearance and childcare certifications."
                              );
                            }}
                            className="gap-1 bg-[#087F78] text-white hover:bg-[#066B65] disabled:opacity-50"
                          >
                            <UserCheck className="size-3.5" />
                            Approve Caregiver
                          </Button>

                          <Button
                            variant="destructive"
                            size="xs"
                            onClick={() => {
                              setActiveCaregiver(cg);
                              setCaregiverDialogMode("reject");
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

                      {!canApprove &&
                        cg.approvalEligibility.reasons.length > 0 && (
                          <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                            <p className="font-bold">
                              Caregiver Approval Blocked:
                            </p>
                            <ul className="mt-1 list-disc space-y-0.5 pl-4">
                              {cg.approvalEligibility.reasons.map((r, idx) => (
                                <li key={idx}>{r}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                    </div>
                  );
                })}
              </div>
            )
          ) : documentItems.length === 0 ? (
            <div className="rounded-2xl border border-dashed py-12 text-center text-sm text-muted-foreground">
              No verification documents match your current filters.
            </div>
          ) : (
            <div className="space-y-3">
              {documentItems.map((doc) => (
                <div
                  key={doc.id}
                  className="flex flex-col justify-between gap-3 rounded-2xl border border-slate-200/80 bg-background p-4 shadow-2xs sm:flex-row sm:items-center dark:border-border"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-sm">
                        {doc.documentTitle}
                      </span>
                      <StatusPill status={doc.status} />
                      {doc.replacementRequested && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                          Replacement Requested
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Type: <strong>{doc.documentType}</strong> • Provider:{" "}
                      {doc.providerName || doc.providerId}
                      {doc.centerName ? ` • Centre: ${doc.centerName}` : ""}
                      {doc.caregiverName
                        ? ` • Caregiver: ${doc.caregiverName}`
                        : ""}{" "}
                      • {Math.round(doc.fileSizeBytes / 1024)} KB •{" "}
                      {doc.mimeType} • Malware Scan: {doc.malwareScanStatus}
                    </p>
                    {doc.rejectionReason && (
                      <p className="text-xs font-medium text-rose-600">
                        Rejection Reason: {doc.rejectionReason}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      size="xs"
                      disabled={doc.isExpired || doc.status === "VERIFIED"}
                      onClick={() => {
                        setActiveDocument(doc);
                        setDocumentDialogMode("approve");
                        setComments(
                          `Verified authenticity and validity of ${doc.documentTitle}.`
                        );
                      }}
                      className="bg-[#087F78] text-white hover:bg-[#066B65]"
                    >
                      Approve Doc
                    </Button>
                    <Button
                      variant="destructive"
                      size="xs"
                      onClick={() => {
                        setActiveDocument(doc);
                        setDocumentDialogMode("reject");
                        setRejectionReason("");
                        setReplacementRequested(true);
                      }}
                    >
                      Reject Doc
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Provider Action Dialog */}
      <Dialog
        open={Boolean(activeProvider && providerDialogMode)}
        onOpenChange={(open) => {
          if (!open) {
            setActiveProvider(null);
            setProviderDialogMode(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {providerDialogMode === "approve" &&
                "Approve Provider Verification"}
              {providerDialogMode === "reject" &&
                "Reject or Suspend Provider Verification"}
              {providerDialogMode === "request-docs" &&
                "Request Additional Documentation"}
            </DialogTitle>
            <DialogDescription>
              Provider: <strong>{activeProvider?.organizationName}</strong>
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleProviderSubmit} className="space-y-4">
            {providerDialogMode === "approve" && (
              <div className="space-y-2 rounded-xl border bg-muted/30 p-3 text-xs">
                <p className="font-bold">Mandatory Verification Checklist</p>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={providerChecklist.licenseVerified}
                    onChange={(e) =>
                      setProviderChecklist((prev) => ({
                        ...prev,
                        licenseVerified: e.target.checked,
                      }))
                    }
                  />
                  State childcare license & registration verified
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={providerChecklist.organizationDetailsVerified}
                    onChange={(e) =>
                      setProviderChecklist((prev) => ({
                        ...prev,
                        organizationDetailsVerified: e.target.checked,
                      }))
                    }
                  />
                  Organization contact & compliance identity verified
                </label>
              </div>
            )}

            {providerDialogMode === "reject" && (
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
                  Mark provider status as SUSPENDED (revokes existing
                  verification)
                </label>
              </>
            )}

            {providerDialogMode === "request-docs" && (
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
                required={providerDialogMode !== "reject"}
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
                  setActiveProvider(null);
                  setProviderDialogMode(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                className={
                  providerDialogMode === "reject"
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

      {/* Center Action Dialog */}
      <Dialog
        open={Boolean(activeCenter && centerDialogMode)}
        onOpenChange={(open) => {
          if (!open) {
            setActiveCenter(null);
            setCenterDialogMode(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {centerDialogMode === "approve" &&
                "Approve Daycare Centre Verification"}
              {centerDialogMode === "reject" &&
                "Reject or Suspend Daycare Centre"}
              {centerDialogMode === "request-docs" &&
                "Request Centre Documentation"}
            </DialogTitle>
            <DialogDescription>
              Centre: <strong>{activeCenter?.centerName}</strong>
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCenterSubmit} className="space-y-4">
            {centerDialogMode === "approve" && (
              <div className="space-y-2 rounded-xl border bg-muted/30 p-3 text-xs">
                <p className="font-bold">Mandatory Centre Safety Checklist</p>
                {(
                  [
                    [
                      "operatingLicenseVerified",
                      "Operating license verified",
                    ],
                    [
                      "facilitySafetyVerified",
                      "Facility safety & fire inspection verified",
                    ],
                    [
                      "caregiverQualificationVerified",
                      "Verified caregiver staffing confirmed",
                    ],
                    [
                      "capacityVerified",
                      "Approved childcare capacity & age groups verified",
                    ],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={centerChecklist[key]}
                      onChange={(e) =>
                        setCenterChecklist((prev) => ({
                          ...prev,
                          [key]: e.target.checked,
                        }))
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            )}

            {centerDialogMode === "reject" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="center-rejection-reason">
                    Rejection / Suspension Reason (Required)
                  </Label>
                  <Textarea
                    id="center-rejection-reason"
                    required
                    minLength={5}
                    value={rejectionReason}
                    onChange={(e) => setRejectionReason(e.target.value)}
                  />
                </div>
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    checked={suspendAlso}
                    onChange={(e) => setSuspendAlso(e.target.checked)}
                    className="size-4 rounded"
                  />
                  Mark centre status as SUSPENDED
                </label>
              </>
            )}

            {centerDialogMode === "request-docs" && (
              <div className="space-y-1.5">
                <Label htmlFor="center-req-docs">
                  Required Document Codes (Comma-separated)
                </Label>
                <Input
                  id="center-req-docs"
                  required
                  value={docRequestInput}
                  onChange={(e) => setDocRequestInput(e.target.value)}
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="center-review-comments">Reviewer Comments</Label>
              <Textarea
                id="center-review-comments"
                required={centerDialogMode !== "reject"}
                minLength={3}
                value={comments}
                onChange={(e) => setComments(e.target.value)}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setActiveCenter(null);
                  setCenterDialogMode(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                className="bg-[#087F78] text-white hover:bg-[#066B65]"
              >
                {submitting ? "Submitting..." : "Confirm Decision"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Caregiver Action Dialog */}
      <Dialog
        open={Boolean(activeCaregiver && caregiverDialogMode)}
        onOpenChange={(open) => {
          if (!open) {
            setActiveCaregiver(null);
            setCaregiverDialogMode(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {caregiverDialogMode === "approve"
                ? "Approve Caregiver Verification"
                : "Reject or Suspend Caregiver"}
            </DialogTitle>
            <DialogDescription>
              Caregiver: <strong>{activeCaregiver?.fullName}</strong>
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCaregiverSubmit} className="space-y-4">
            {caregiverDialogMode === "reject" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="cg-rejection-reason">
                    Rejection / Suspension Reason (Required)
                  </Label>
                  <Textarea
                    id="cg-rejection-reason"
                    required
                    minLength={5}
                    value={rejectionReason}
                    onChange={(e) => setRejectionReason(e.target.value)}
                  />
                </div>
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    checked={suspendAlso}
                    onChange={(e) => setSuspendAlso(e.target.checked)}
                    className="size-4 rounded"
                  />
                  Suspend caregiver from active staffing
                </label>
              </>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="cg-review-comments">Reviewer Comments</Label>
              <Textarea
                id="cg-review-comments"
                required={caregiverDialogMode !== "reject"}
                minLength={3}
                value={comments}
                onChange={(e) => setComments(e.target.value)}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setActiveCaregiver(null);
                  setCaregiverDialogMode(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                className="bg-[#087F78] text-white hover:bg-[#066B65]"
              >
                {submitting ? "Submitting..." : "Confirm Decision"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Document Action Dialog */}
      <Dialog
        open={Boolean(activeDocument && documentDialogMode)}
        onOpenChange={(open) => {
          if (!open) {
            setActiveDocument(null);
            setDocumentDialogMode(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {documentDialogMode === "approve"
                ? "Approve Verification Document"
                : "Reject Verification Document"}
            </DialogTitle>
            <DialogDescription>
              Document: <strong>{activeDocument?.documentTitle}</strong>
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleDocumentSubmit} className="space-y-4">
            {documentDialogMode === "reject" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="doc-rejection-reason">
                    Rejection Reason (Required)
                  </Label>
                  <Textarea
                    id="doc-rejection-reason"
                    required
                    minLength={5}
                    value={rejectionReason}
                    onChange={(e) => setRejectionReason(e.target.value)}
                  />
                </div>
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    checked={replacementRequested}
                    onChange={(e) => setReplacementRequested(e.target.checked)}
                    className="size-4 rounded"
                  />
                  Request replacement document from provider
                </label>
              </>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="doc-review-comments">Reviewer Comments</Label>
              <Textarea
                id="doc-review-comments"
                required={documentDialogMode !== "reject"}
                minLength={3}
                value={comments}
                onChange={(e) => setComments(e.target.value)}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setActiveDocument(null);
                  setDocumentDialogMode(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                className="bg-[#087F78] text-white hover:bg-[#066B65]"
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
