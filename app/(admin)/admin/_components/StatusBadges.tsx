import { Badge } from "@/components/ui/badge";

export function StatusPill({ status }: { status: string }) {
  const normalized = (status || "").toUpperCase();

  let colorClass =
    "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300";

  if (
    [
      "ACTIVE",
      "APPROVED",
      "CONFIRMED",
      "COMPLETED",
      "RESOLVED",
      "VERIFIED",
      "PAID",
    ].includes(normalized)
  ) {
    colorClass =
      "bg-[#EAF8F5] text-[#087F78] border-[#BCE6DF] dark:bg-teal-950/60 dark:text-teal-300 dark:border-teal-800";
  } else if (
    [
      "PENDING",
      "UNDER_REVIEW",
      "REQUESTED",
      "INVESTIGATING",
      "CHECKED_IN",
      "PENDING_APPROVAL",
      "SUBMITTED",
      "MEDIUM",
      "OPEN",
    ].includes(normalized)
  ) {
    colorClass =
      "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800";
  } else if (
    [
      "REJECTED",
      "SUSPENDED",
      "DISABLED",
      "CANCELLED",
      "NO_SHOW",
      "EXPIRED",
      "HIGH",
      "CRITICAL",
      "DISPUTED",
    ].includes(normalized)
  ) {
    colorClass =
      "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-800";
  }

  return (
    <Badge
      variant="outline"
      className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide ${colorClass}`}
    >
      {normalized.replace(/_/g, " ")}
    </Badge>
  );
}
