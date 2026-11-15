"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Building2,
  CalendarCheck2,
  ChevronRight,
  ClipboardCheck,
  FileSearch,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";

import { ModeToggle } from "@/app/_shared/ModeToggle";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { AuthenticatedAdmin } from "@/lib/admin/types";
import { adminAuth, dashboard } from "@/lib/api/admin-api";

const SIDEBAR_NAV_ITEMS = [
  {
    title: "Dashboard",
    href: "/admin/dashboard",
    icon: LayoutDashboard,
  },
  {
    title: "Users",
    href: "/admin/users",
    icon: Users,
  },
  {
    title: "Providers",
    href: "/admin/providers",
    icon: ShieldCheck,
  },
  {
    title: "Verifications",
    href: "/admin/verifications",
    icon: ClipboardCheck,
  },
  {
    title: "Daycare Centres",
    href: "/admin/centers",
    icon: Building2,
  },
  {
    title: "Bookings",
    href: "/admin/bookings",
    icon: CalendarCheck2,
  },
  {
    title: "Safety Incidents",
    href: "/admin/incidents",
    icon: AlertTriangle,
  },
  {
    title: "Reports",
    href: "/admin/reports",
    icon: BarChart3,
  },
  {
    title: "Audit Logs",
    href: "/admin/audit-logs",
    icon: FileSearch,
  },
  {
    title: "Settings",
    href: "/admin/settings",
    icon: Settings,
  },
];

export function AdminPortalShell({
  admin,
  children,
}: {
  admin: AuthenticatedAdmin;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [notifications, setNotifications] = useState<
    Array<{
      id: string;
      type: string;
      title: string;
      message: string;
      isRead: boolean;
      createdAt: string;
    }>
  >([]);

  useEffect(() => {
    let mounted = true;
    dashboard
      .getActivity()
      .then((res) => {
        if (mounted && res.notifications) {
          setNotifications(res.notifications);
        }
      })
      .catch(() => {
        // Ignore silent notification polling error
      });
    return () => {
      mounted = false;
    };
  }, [pathname]);

  const currentNav =
    SIDEBAR_NAV_ITEMS.find(
      (item) =>
        pathname === item.href || pathname.startsWith(`${item.href}/`)
    ) ?? SIDEBAR_NAV_ITEMS[0];

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await adminAuth.logout();
      router.replace("/admin/login");
      router.refresh();
    } finally {
      setLoggingOut(false);
    }
  };

  const initials = admin.name
    .split(" ")
    .map((p) => p.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="flex min-h-screen w-full bg-[#F6FBF9] text-slate-900 dark:bg-background dark:text-foreground">
      {/* Persistent Desktop & Collapsible Tablet Sidebar */}
      <aside
        className={`hidden shrink-0 flex-col border-r border-slate-200/80 bg-white transition-all duration-200 dark:border-border dark:bg-card lg:flex ${
          sidebarCollapsed ? "w-20" : "w-68"
        }`}
        aria-label="Admin Portal Navigation"
      >
        {/* Brand Header */}
        <div className="flex h-20 items-center justify-between border-b border-slate-200/70 px-4 dark:border-border">
          {!sidebarCollapsed && (
            <Link
              href="/admin/dashboard"
              className="flex items-center gap-2"
              aria-label="Little Steps Admin Home"
            >
              <Image
                src="/Images/logo.svg"
                alt="Little Steps"
                width={175}
                height={42}
                preload
                className="h-auto w-41 object-contain"
              />
            </Link>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSidebarCollapsed((c) => !c)}
            aria-label={
              sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
            }
            className="mx-auto text-[#087F78] hover:bg-[#EAF8F5]"
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </Button>
        </div>

        {/* Navigation Links */}
        <nav className="flex flex-1 flex-col gap-1.5 overflow-y-auto p-3">
          {SIDEBAR_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={sidebarCollapsed ? item.title : undefined}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-[#087F78] text-white shadow-xs"
                    : "text-slate-600 hover:bg-[#EAF8F5] hover:text-[#087F78] dark:text-muted-foreground dark:hover:bg-teal-950/50 dark:hover:text-teal-300"
                } ${sidebarCollapsed ? "justify-center px-2" : ""}`}
              >
                <Icon className="size-4.5 shrink-0" />
                {!sidebarCollapsed && <span>{item.title}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Bottom Admin Badge & Logout */}
        <div className="flex flex-col gap-2 border-t border-slate-200/80 p-3 dark:border-border">
          {!sidebarCollapsed && (
            <div className="flex items-center gap-2.5 rounded-xl bg-[#EAF8F5]/70 px-3 py-2.5 dark:bg-teal-950/30">
              <Avatar className="size-8 bg-[#087F78] text-white">
                <AvatarFallback className="bg-[#087F78] text-xs font-bold text-white">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-xs font-bold text-slate-900 dark:text-foreground">
                  {admin.name}
                </span>
                <span className="truncate text-[11px] text-[#087F78] dark:text-teal-300">
                  {admin.role}
                </span>
              </div>
            </div>
          )}

          <Button
            variant="ghost"
            disabled={loggingOut}
            onClick={handleLogout}
            className={`justify-start gap-2.5 rounded-xl text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:text-rose-400 dark:hover:bg-rose-950/40 ${
              sidebarCollapsed ? "justify-center px-2" : "px-3.5"
            }`}
          >
            <LogOut className="size-4 shrink-0" />
            {!sidebarCollapsed && (
              <span>{loggingOut ? "Signing out..." : "Logout"}</span>
            )}
          </Button>
        </div>
      </aside>

      {/* Mobile Navigation Sheet */}
      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent
          side="left"
          className="flex w-76 flex-col bg-background p-5"
        >
          <SheetHeader className="border-b pb-4 text-left">
            <SheetTitle className="flex items-center gap-2 text-lg font-bold text-[#087F78]">
              Little Steps Admin
            </SheetTitle>
            <SheetDescription className="text-xs">
              Trusted 24×7 Childcare Operations Portal
            </SheetDescription>
          </SheetHeader>

          <nav
            className="mt-4 flex flex-1 flex-col gap-1.5 overflow-y-auto"
            aria-label="Mobile Admin Navigation"
          >
            {SIDEBAR_NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active =
                pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-colors ${
                    active
                      ? "bg-[#087F78] text-white"
                      : "text-foreground hover:bg-[#EAF8F5] hover:text-[#087F78]"
                  }`}
                >
                  <Icon className="size-4.5 shrink-0" />
                  <span>{item.title}</span>
                </Link>
              );
            })}
          </nav>

          <div className="mt-auto border-t pt-4">
            <Button
              variant="outline"
              disabled={loggingOut}
              onClick={handleLogout}
              className="w-full gap-2 rounded-full border-rose-200 text-rose-600 hover:bg-rose-50"
            >
              <LogOut className="size-4" />
              {loggingOut ? "Signing out..." : "Logout"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Main Content Flex Column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Navigation Header */}
        <header className="sticky top-0 z-30 flex h-20 w-full items-center justify-between gap-4 border-b border-slate-200/80 bg-white/95 px-4 backdrop-blur-md dark:border-border dark:bg-card/95 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open admin sidebar"
              className="text-[#087F78] hover:bg-[#EAF8F5] lg:hidden"
            >
              <Menu className="size-5" />
            </Button>

            <div className="flex flex-col">
              <div className="hidden items-center gap-1.5 text-xs text-slate-500 dark:text-muted-foreground sm:flex">
                <span>Admin Portal</span>
                <ChevronRight className="size-3.5" />
                <span className="font-medium text-[#087F78] dark:text-teal-300">
                  {currentNav.title}
                </span>
              </div>
              <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-foreground sm:text-xl">
                {currentNav.title}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2.5 sm:gap-3">
            <Badge className="hidden rounded-full bg-[#EAF8F5] px-3 py-1 text-xs font-semibold text-[#087F78] md:inline-flex dark:bg-teal-950/60 dark:text-teal-300">
              {admin.role}
            </Badge>

            {/* Notifications Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon"
                    className="relative"
                    aria-label="Admin notifications"
                  />
                }
              >
                <Bell className="size-4" />
                {notifications.length > 0 && (
                  <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-[#F2A65A] text-[10px] font-bold text-slate-950">
                    {notifications.length}
                  </span>
                )}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Platform Alerts</DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                {notifications.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                    No active platform alerts
                  </div>
                ) : (
                  notifications.slice(0, 5).map((n) => (
                    <DropdownMenuItem
                      key={n.id}
                      className="flex flex-col items-start gap-1 py-2"
                    >
                      <span className="text-xs font-semibold text-foreground">
                        {n.title}
                      </span>
                      <span className="text-[11px] leading-snug text-muted-foreground">
                        {n.message}
                      </span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <ModeToggle />

            {/* Admin Profile Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    className="gap-2 rounded-full px-2.5 py-1.5"
                  />
                }
              >
                <Avatar className="size-6 bg-[#087F78] text-white">
                  <AvatarFallback className="bg-[#087F78] text-[11px] font-bold text-white">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <span className="hidden max-w-32 truncate text-xs font-semibold sm:inline">
                  {admin.name}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="flex flex-col gap-0.5">
                    <span className="text-xs font-bold text-foreground">
                      {admin.name}
                    </span>
                    <span className="text-[11px] font-normal text-muted-foreground">
                      {admin.email}
                    </span>
                    <span className="mt-1 inline-flex w-fit rounded bg-[#EAF8F5] px-1.5 py-0.5 text-[10px] font-semibold text-[#087F78] dark:bg-teal-950 dark:text-teal-300">
                      {admin.title} • {admin.department}
                    </span>
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => router.push("/admin/settings")}>
                  <Settings className="size-4" />
                  Platform Settings
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/admin/audit-logs")}
                >
                  <FileSearch className="size-4" />
                  Security Audit Trail
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={handleLogout}
                >
                  <LogOut className="size-4" />
                  Sign Out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="flex flex-1 flex-col p-4 sm:p-6 lg:p-8">
          <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
