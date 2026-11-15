import { type NextRequest, NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE_NAME } from "@/server/security/crypto";

const PUBLIC_ADMIN_PATHS = new Set(["/admin/login", "/admin/verify-otp"]);

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === "/admin") {
    const sessionCookie = request.cookies.get(ADMIN_SESSION_COOKIE_NAME)?.value;
    const destination = sessionCookie ? "/admin/dashboard" : "/admin/login";
    return NextResponse.redirect(new URL(destination, request.url));
  }

  if (pathname.startsWith("/admin/") && !PUBLIC_ADMIN_PATHS.has(pathname)) {
    const sessionCookie = request.cookies.get(ADMIN_SESSION_COOKIE_NAME)?.value;
    if (!sessionCookie) {
      const loginUrl = new URL("/admin/login", request.url);
      loginUrl.searchParams.set("redirect", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
