"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Eye,
  Fingerprint,
  RefreshCw,
  Search,
  ShieldCheck,
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type AdminAuditLogEntry,
  reports as reportsApi,
} from "@/lib/api/admin-api";
import { extractApiErrorMessage } from "@/lib/api/axios-client";

export default function AdminAuditLogsPage() {
  const [logs, setLogs] = useState<AdminAuditLogEntry[]>([]);
  const [search, setSearch] = useState("");
  const [entityType, setEntityType] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedLog, setSelectedLog] = useState<AdminAuditLogEntry | null>(
    null
  );

  const loadAuditLogs = useCallback(async () => {
    try {
      const data = await reportsApi.listAuditLogs({
        search: search || undefined,
        entityType: entityType || undefined,
        limit: 100,
      });
      setLogs(data);
      setError(null);
    } catch (err) {
      setError(extractApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [search, entityType]);

  useEffect(() => {
    void Promise.resolve().then(loadAuditLogs);
  }, [loadAuditLogs]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[#0B3B3C] dark:text-teal-50">
            Tamper-Evident Administrative Audit Logs
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Immutable administrative ledger recording every OTP login, user
            status change, provider review, booking transition, and incident
            update with HMAC-SHA256 integrity hashes.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void loadAuditLogs()}
          disabled={loading}
          className="rounded-xl"
        >
          <RefreshCw
            className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Refresh Ledger
        </Button>
      </div>

      {/* Filters */}
      <Card className="border-slate-200/80 dark:border-slate-800">
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="relative md:col-span-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by administrator email, action code, or summary..."
                className="pl-9"
              />
            </div>
            <select
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="">All Entity Types</option>
              <option value="ADMIN_AUTH">ADMIN AUTH</option>
              <option value="USER">USER</option>
              <option value="PROVIDER_VERIFICATION">
                PROVIDER VERIFICATION
              </option>
              <option value="CENTER">CENTER</option>
              <option value="BOOKING">BOOKING</option>
              <option value="SAFETY_INCIDENT">SAFETY INCIDENT</option>
              <option value="PLATFORM_SETTING">PLATFORM SETTING</option>
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
          <CardTitle className="flex items-center gap-2 text-base font-bold">
            <ShieldCheck className="h-4 w-4 text-[#087F78]" />
            Audit Trail Entries ({logs.length})
          </CardTitle>
          <CardDescription>
            Each record includes a cryptographic HMAC-SHA256 signature over the
            actor, entity, state transition, and timestamp.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>Administrator</TableHead>
                <TableHead>Action & Entity</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead>Integrity Hash</TableHead>
                <TableHead className="text-right">Inspect</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-8 text-center text-sm text-slate-500"
                  >
                    Loading audit log ledger...
                  </TableCell>
                </TableRow>
              ) : logs.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-8 text-center text-sm text-slate-500"
                  >
                    No audit log entries match the filter criteria.
                  </TableCell>
                </TableRow>
              ) : (
                logs.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="text-xs text-slate-500">
                      {new Date(entry.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs font-medium text-slate-800 dark:text-slate-200">
                      {entry.adminEmail}
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-xs font-bold text-[#087F78] dark:text-teal-300">
                        {entry.action}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {entry.entityType}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-md whitespace-normal text-xs text-slate-700 dark:text-slate-300">
                      {entry.summary}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        <Fingerprint className="h-3 w-3 text-[#087F78]" />
                        {entry.integrityHash.slice(0, 12)}…
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => setSelectedLog(entry)}
                      >
                        <Eye className="mr-1 h-3.5 w-3.5" />
                        Payload
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Audit Log State Diff Dialog */}
      <Dialog
        open={Boolean(selectedLog)}
        onOpenChange={(open) => !open && setSelectedLog(null)}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              {selectedLog?.action}
            </DialogTitle>
            <DialogDescription>{selectedLog?.summary}</DialogDescription>
          </DialogHeader>

          {selectedLog && (
            <div className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-900/50">
                <div>
                  <p className="text-slate-500">Actor Email</p>
                  <p className="font-semibold text-slate-900 dark:text-white">
                    {selectedLog.adminEmail}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">IP Address</p>
                  <p className="font-mono text-slate-800 dark:text-slate-200">
                    {selectedLog.ipAddress ?? "127.0.0.1"}
                  </p>
                </div>
                <div className="col-span-2">
                  <p className="text-slate-500">
                    HMAC-SHA256 Tamper-Evident Integrity Signature
                  </p>
                  <p className="mt-0.5 break-all font-mono text-[11px] text-[#087F78]">
                    {selectedLog.integrityHash}
                  </p>
                </div>
              </div>

              <div>
                <p className="mb-1 font-bold text-slate-700 dark:text-slate-300">
                  Previous State Snapshot
                </p>
                <pre className="overflow-x-auto rounded-xl border border-slate-200 bg-slate-950 p-3 text-[11px] text-slate-200">
                  {JSON.stringify(selectedLog.previousState ?? {}, null, 2)}
                </pre>
              </div>

              <div>
                <p className="mb-1 font-bold text-slate-700 dark:text-slate-300">
                  New State Snapshot
                </p>
                <pre className="overflow-x-auto rounded-xl border border-slate-200 bg-slate-950 p-3 text-[11px] text-emerald-300">
                  {JSON.stringify(selectedLog.newState ?? {}, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
