import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ADMIN_SESSION_COOKIE_NAME } from "@/server/security/crypto";
import { validateAdminSessionToken } from "@/server/services/admin-auth.service";
import { AdminPortalShell } from "./_components/AdminPortalShell";

async function AuthenticatedAdminGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const rawSession = cookieStore.get(ADMIN_SESSION_COOKIE_NAME)?.value;
  const admin = await validateAdminSessionToken(rawSession);

  if (!admin) {
    redirect("/admin/login");
  }

  return <AdminPortalShell admin={admin}>{children}</AdminPortalShell>;
}

export default function AdminPortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#F6FBF9] text-sm font-medium text-[#087F78] dark:bg-background">
          Verifying administrator session...
        </div>
      }
    >
      <AuthenticatedAdminGate>{children}</AuthenticatedAdminGate>
    </Suspense>
  );
}
