"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Eye,
  RefreshCw,
  Search,
  ShieldAlert,
  UserCheck,
  UserX,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  type AdminUserDetail,
  type AdminUserListItem,
  users,
} from "@/lib/api/admin-api";
import { StatusPill } from "../_components/StatusBadges";

export default function AdminUsersPage() {
  const [userList, setUserList] = useState<AdminUserListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");

  const [selectedUser, setSelectedUser] = useState<AdminUserDetail | null>(
    null
  );
  const [detailLoading, setDetailLoading] = useState(false);

  const [actionUser, setActionUser] = useState<AdminUserListItem | null>(null);
  const [nextStatus, setNextStatus] = useState<
    "ACTIVE" | "SUSPENDED" | "DISABLED"
  >("SUSPENDED");
  const [reason, setReason] = useState("");
  const [submittingStatus, setSubmittingStatus] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await users.list({
        search: search || undefined,
        role: roleFilter !== "ALL" ? roleFilter : undefined,
        status: statusFilter !== "ALL" ? statusFilter : undefined,
      });
      setUserList(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users.");
    } finally {
      setLoading(false);
    }
  }, [search, roleFilter, statusFilter]);

  useEffect(() => {
    void Promise.resolve().then(loadUsers);
  }, [loadUsers]);

  const handleOpenDetail = async (id: string) => {
    setDetailLoading(true);
    try {
      const detail = await users.getById(id);
      setSelectedUser(detail);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to load user details."
      );
    } finally {
      setDetailLoading(false);
    }
  };

  const handleConfirmStatusUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!actionUser) return;
    setSubmittingStatus(true);
    setError(null);
    try {
      await users.updateStatus(actionUser.id, {
        status: nextStatus,
        reason: reason.trim(),
      });
      setFeedback(
        `Updated ${actionUser.email} to ${nextStatus} and recorded audit log.`
      );
      setActionUser(null);
      setReason("");
      await loadUsers();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update account status."
      );
    } finally {
      setSubmittingStatus(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <CardTitle className="text-lg font-bold">
              Registered Users & Role Directory
            </CardTitle>
            <CardDescription>
              Search and filter parents, childcare providers, caregivers, and
              administrators
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={loadUsers}
            className="gap-1.5 rounded-full"
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        </CardHeader>

        <CardContent className="space-y-4">
          {feedback && (
            <Alert className="border-teal-300 bg-[#EAF8F5] text-[#087F78] dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-200">
              <AlertTitle>Status Updated</AlertTitle>
              <AlertDescription>{feedback}</AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>Action Failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Filters */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Search by user name or email..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-10 rounded-xl pl-9"
              />
            </div>

            <select
              aria-label="Filter by role"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              className="h-10 rounded-xl border border-input bg-background px-3 text-xs font-medium"
            >
              <option value="ALL">All Roles</option>
              <option value="PARENT">Parents</option>
              <option value="PROVIDER">Providers</option>
              <option value="CAREGIVER">Caregivers</option>
              <option value="ADMIN">Admins</option>
              <option value="SUPER_ADMIN">Super Admins</option>
            </select>

            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-10 rounded-xl border border-input bg-background px-3 text-xs font-medium"
            >
              <option value="ALL">All Account Statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended</option>
              <option value="DISABLED">Disabled</option>
            </select>
          </div>

          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-xl" />
              ))}
            </div>
          ) : userList.length === 0 ? (
            <div className="rounded-2xl border border-dashed py-12 text-center text-sm text-muted-foreground">
              No users match the selected search or filter criteria.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name & Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Bookings</TableHead>
                    <TableHead>Registered</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {userList.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-semibold text-foreground">
                            {u.name}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {u.email}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusPill status={u.role} />
                      </TableCell>
                      <TableCell>
                        <StatusPill status={u.status} />
                      </TableCell>
                      <TableCell className="text-xs font-medium">
                        {u.bookingsCount}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(u.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={detailLoading}
                            onClick={() => handleOpenDetail(u.id)}
                          >
                            <Eye className="size-3.5" />
                            Details
                          </Button>
                          {u.status === "ACTIVE" ? (
                            <Button
                              variant="destructive"
                              size="xs"
                              onClick={() => {
                                setActionUser(u);
                                setNextStatus("SUSPENDED");
                                setReason("");
                              }}
                            >
                              <UserX className="size-3.5" />
                              Suspend
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="xs"
                              className="border-[#087F78] text-[#087F78]"
                              onClick={() => {
                                setActionUser(u);
                                setNextStatus("ACTIVE");
                                setReason("");
                              }}
                            >
                              <UserCheck className="size-3.5" />
                              Reactivate
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* User Profile Details Dialog */}
      <Dialog
        open={Boolean(selectedUser)}
        onOpenChange={(open) => !open && setSelectedUser(null)}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{selectedUser?.name}</DialogTitle>
            <DialogDescription>
              {selectedUser?.email} • Registered{" "}
              {selectedUser
                ? new Date(selectedUser.createdAt).toLocaleDateString()
                : ""}
            </DialogDescription>
          </DialogHeader>

          {selectedUser && (
            <div className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3 rounded-xl bg-muted/50 p-3">
                <div>
                  <span className="text-muted-foreground">Primary Role:</span>
                  <div className="mt-1">
                    <StatusPill status={selectedUser.role} />
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground">Account Status:</span>
                  <div className="mt-1">
                    <StatusPill status={selectedUser.status} />
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground">Phone:</span>
                  <p className="font-semibold">
                    {selectedUser.phone || "Not provided"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Last Login:</span>
                  <p className="font-semibold">
                    {selectedUser.lastLoginAt
                      ? new Date(selectedUser.lastLoginAt).toLocaleString()
                      : "Never"}
                  </p>
                </div>
              </div>

              {selectedUser.suspendedReason && (
                <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3 text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200">
                  <strong>Suspension Reason:</strong>{" "}
                  {selectedUser.suspendedReason}
                </div>
              )}

              {selectedUser.childrenSummary.length > 0 && (
                <div>
                  <p className="mb-1.5 font-bold text-foreground">
                    Registered Children (Privacy-Redacted View)
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {selectedUser.childrenSummary.map((ch) => (
                      <span
                        key={ch.id}
                        className="rounded-lg border bg-background px-2.5 py-1"
                      >
                        Child {ch.displayInitial} • {ch.ageGroup} ({ch.ageMonths}{" "}
                        mos)
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <p className="mb-1.5 font-bold text-foreground">
                  Booking Activity ({selectedUser.bookings.length})
                </p>
                {selectedUser.bookings.length === 0 ? (
                  <p className="text-muted-foreground">
                    No bookings recorded for this user.
                  </p>
                ) : (
                  <div className="max-h-40 space-y-1.5 overflow-y-auto">
                    {selectedUser.bookings.map((b) => (
                      <div
                        key={b.id}
                        className="flex items-center justify-between rounded-lg border px-3 py-2"
                      >
                        <div>
                          <span className="font-semibold">
                            {b.bookingReference}
                          </span>{" "}
                          • {b.centerName}
                        </div>
                        <StatusPill status={b.status} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Suspend / Reactivate Confirmation Dialog */}
      <Dialog
        open={Boolean(actionUser)}
        onOpenChange={(open) => !open && setActionUser(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-[#F2A65A]" />
              {nextStatus === "ACTIVE"
                ? "Reactivate User Account"
                : "Suspend / Disable User Account"}
            </DialogTitle>
            <DialogDescription>
              Modify account status for <strong>{actionUser?.email}</strong>.
              This action is recorded in the administrative audit log.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleConfirmStatusUpdate} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="target-status">Target Status</Label>
              <select
                id="target-status"
                value={nextStatus}
                onChange={(e) =>
                  setNextStatus(
                    e.target.value as "ACTIVE" | "SUSPENDED" | "DISABLED"
                  )
                }
                className="h-10 w-full rounded-xl border border-input bg-background px-3 text-xs font-medium"
              >
                <option value="ACTIVE">ACTIVE (Full Access)</option>
                <option value="SUSPENDED">SUSPENDED (Temporary Hold)</option>
                <option value="DISABLED">DISABLED (Permanent Lock)</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="status-reason">
                Audit Reason (Minimum 5 characters)
              </Label>
              <Textarea
                id="status-reason"
                required
                minLength={5}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Provide a clear compliance or operational reason for this account status change..."
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setActionUser(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submittingStatus || reason.trim().length < 5}
                className="bg-[#087F78] text-white hover:bg-[#066B65]"
              >
                {submittingStatus ? "Saving..." : "Confirm Status Change"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
