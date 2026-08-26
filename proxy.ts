/**
 * Next.js Proxy boundary for CMP authentication.
 *
 * When CMP_AUTH_ENABLED=true:
 *   - Public paths pass through (login, unauthorized, auth API, assets)
 *   - Unauthenticated page requests redirect to /login
 *   - Unauthenticated API requests get 401 JSON
 *   - Admin/concept paths require admin role; insufficient role redirects/403
 *
 * When CMP_AUTH_ENABLED is absent/false: pass-through (no-op).
 *
 * Server route guards remain authoritative even if Proxy is bypassed.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

const PUBLIC_PATHS = [
  "/login",
  "/unauthorized",
  "/api/auth",
  "/_next",
  "/brand",
  "/favicon.ico",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(path + "/")
  );
}

function isAdminPath(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/api/admin/") ||
    pathname.startsWith("/concepts")
  );
}

function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

export async function proxy(request: NextRequest) {
  if (process.env.CMP_AUTH_ENABLED !== "true") {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const token = await getToken({ req: request });

  if (!token) {
    if (isApiPath(pathname)) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isAdminPath(pathname) && token.role !== "admin") {
    if (isApiPath(pathname)) {
      return NextResponse.json(
        { error: "Insufficient permissions." },
        { status: 403 }
      );
    }
    return NextResponse.redirect(new URL("/unauthorized", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/).*)"],
};
