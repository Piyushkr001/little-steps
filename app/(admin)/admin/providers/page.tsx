"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Building2,
  ClipboardCheck,
  FileText,
  Globe,
  Mail,
  Phone,
  RefreshCw,
  Search,
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AdminProviderListItem,
  providers,
} from "@/lib/api/admin-api";
import { StatusPill } from "../_components/StatusBadges";

export default function AdminProvidersPage() {
  const [items, setItems] = useState<AdminProviderListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await providers.list({
        search: search || undefined,
        status: statusFilter !== "ALL" ? statusFilter : undefined,
      });
      setItems(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load providers."
      );
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => {
    void Promise.resolve().then(loadProviders);
  }, [loadProviders]);

  return (
    <div className="flex flex-col gap-6">
      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <CardTitle className="text-lg font-bold">
              Childcare Provider Organizations
            </CardTitle>
            <CardDescription>
              Registered daycare operators, compliance statuses, and public
              listing eligibility
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={loadProviders}
              className="gap-1.5 rounded-full"
            >
              <RefreshCw className="size-3.5" />
              Refresh
            </Button>
            <Button
              size="sm"
              nativeButton={false}
              render={<Link href="/admin/verifications" />}
              className="gap-1.5 rounded-full bg-[#087F78] text-white hover:bg-[#066B65]"
            >
              <ClipboardCheck className="size-3.5" />
              Verification Queue
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Search by organization name, registration #, or city..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-10 rounded-xl pl-9"
              />
            </div>

            <select
              aria-label="Filter by verification status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-10 rounded-xl border border-input bg-background px-3 text-xs font-medium"
            >
              <option value="ALL">All Verification Statuses</option>
              <option value="APPROVED">Approved</option>
              <option value="PENDING">Pending</option>
              <option value="UNDER_REVIEW">Under Review</option>
              <option value="REJECTED">Rejected</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </div>

          {loading ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-44 rounded-2xl" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-2xl border border-dashed py-12 text-center text-sm text-muted-foreground">
              No childcare providers found matching your filter criteria.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {items.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-200/80 bg-background p-5 shadow-2xs dark:border-border"
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-base font-bold text-foreground">
                          {p.organizationName}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          Reg #{p.registrationNumber} • {p.city}, {p.state}{" "}
                          {p.postalCode}
                        </p>
                      </div>
                      <StatusPill status={p.verificationStatus} />
                    </div>

                    <div className="flex flex-wrap gap-3 pt-1 text-xs text-slate-600 dark:text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Mail className="size-3.5 text-[#087F78]" />
                        {p.contactEmail}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Phone className="size-3.5 text-[#087F78]" />
                        {p.contactPhone}
                      </span>
                      {p.website && (
                        <span className="inline-flex items-center gap-1">
                          <Globe className="size-3.5 text-[#087F78]" />
                          {p.website}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-xs">
                    <div className="flex items-center gap-3">
                      <span className="inline-flex items-center gap-1 font-medium">
                        <Building2 className="size-3.5 text-[#087F78]" />
                        {p.centersCount} Centre{p.centersCount === 1 ? "" : "s"}
                      </span>
                      <span className="inline-flex items-center gap-1 font-medium">
                        <FileText className="size-3.5 text-[#F2A65A]" />
                        {p.documentsCount} Doc{p.documentsCount === 1 ? "" : "s"}
                      </span>
                      <span className="text-muted-foreground">
                        Publicly Listed:{" "}
                        <strong>{p.isPublished ? "Yes" : "No"}</strong>
                      </span>
                    </div>

                    <Button
                      variant="outline"
                      size="xs"
                      nativeButton={false}
                      render={
                        <Link
                          href={`/admin/verifications?search=${encodeURIComponent(p.organizationName)}`}
                        />
                      }
                      className="rounded-full text-[#087F78]"
                    >
                      Manage Verification
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
