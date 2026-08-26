/**
 * Database-backed access resolution for the user access feature.
 *
 * When CMP_USER_ACCESS_ENABLED=true, this module resolves the
 * authoritative role and access status from PostgreSQL. JWTs retain
 * identity and a display role, but all protected routes and APIs
 * re-resolve from the database so role changes take immediate effect.
 *
 * Bootstrap admin emails from CMP_ADMIN_EMAILS always retain Admin
 * access, even when the database is unavailable.
 */
import "server-only";

import { cookies } from "next/headers";
import { decode } from "next-auth/jwt";
import { parseEmailList, isAuthEnabled, hasCapability, type CmpRole, type CmpCapability } from "./policy";
import type { AppUser, AppUserStatus } from "../user-access/types";

export interface AccessResolution {
  email: string;
  role: CmpRole;
  status: AppUserStatus;
  isBootstrapAdmin: boolean;
}

export function isUserAccessEnabled(env = process.env): boolean {
  return env.CMP_USER_ACCESS_ENABLED === "true";
}

export function getBootstrapAdminEmails(env = process.env): string[] {
  return parseEmailList(env.CMP_ADMIN_EMAILS);
}

export function isBootstrapAdmin(
  email: string,
  env = process.env
): boolean {
  const admins = getBootstrapAdminEmails(env);
  return admins.includes(email.toLowerCase().trim());
}

/**
 * Resolve access from a database user record plus bootstrap config.
 * Bootstrap admins always get admin/active regardless of DB state.
 */
export function resolveAccessFromUser(
  email: string,
  dbUser: AppUser | null,
  env = process.env
): AccessResolution | null {
  const normalized = email.toLowerCase().trim();
  const bootstrap = isBootstrapAdmin(normalized, env);

  // Bootstrap admins always have access
  if (bootstrap) {
    return {
      email: normalized,
      role: "admin",
      status: "active",
      isBootstrapAdmin: true,
    };
  }

  // No DB record means unknown user
  if (!dbUser) return null;

  // Only active users with a role get access
  if (dbUser.status !== "active" || !dbUser.role) return null;

  return {
    email: normalized,
    role: dbUser.role as CmpRole,
    status: dbUser.status,
    isBootstrapAdmin: false,
  };
}

/**
 * Resolve access when the database is unavailable.
 * Only bootstrap admins retain access (fail-closed).
 */
export function resolveAccessFallback(
  email: string,
  env = process.env
): AccessResolution | null {
  const normalized = email.toLowerCase().trim();
  if (isBootstrapAdmin(normalized, env)) {
    return {
      email: normalized,
      role: "admin",
      status: "active",
      isBootstrapAdmin: true,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Server-component page guards
// ---------------------------------------------------------------------------

/**
 * Read the JWT email from the session cookie in a server component.
 * Returns null if auth is disabled or no cookie.
 */
async function getPageEmail(): Promise<string | null> {
  if (!isAuthEnabled()) return null;
  const cookieStore = await cookies();
  const tokenCookie = cookieStore.get("next-auth.session-token")
    ?? cookieStore.get("__Secure-next-auth.session-token");
  if (!tokenCookie?.value) return null;

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return null;

  try {
    const decoded = await decode({ token: tokenCookie.value, secret });
    return (decoded?.email as string)?.toLowerCase().trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the authoritative access for the current page visitor.
 * When user access is disabled, returns the env-derived role.
 * When enabled, resolves from PostgreSQL (fail-closed to bootstrap).
 */
export async function resolvePageAccess(): Promise<AccessResolution | null> {
  const email = await getPageEmail();
  if (!email) return null;

  if (!isUserAccessEnabled()) {
    // Legacy: derive from env
    const { resolveRole } = await import("./policy");
    const role = resolveRole(email);
    if (!role) return null;
    return {
      email,
      role,
      status: "active",
      isBootstrapAdmin: isBootstrapAdmin(email),
    };
  }

  try {
    const { getUserAccessRepository, isUserAccessDatabaseConfigured } =
      await import("../user-access/repository");

    if (!isUserAccessDatabaseConfigured()) {
      return resolveAccessFallback(email);
    }

    const repo = getUserAccessRepository();
    const dbUser = await repo.getUser(email);
    return resolveAccessFromUser(email, dbUser);
  } catch {
    return resolveAccessFallback(email);
  }
}

export type PageGuardResult =
  | { allowed: true; access: AccessResolution }
  | { allowed: false; redirect: string };

/**
 * Authoritative server-page guard for protected pages.
 * Returns the access if allowed, or a redirect path.
 */
export async function requirePageAccess(
  requiredCapability: CmpCapability
): Promise<PageGuardResult> {
  const access = await resolvePageAccess();

  if (!access) {
    return { allowed: false, redirect: "/login" };
  }

  // When user access is enabled, check status
  if (isUserAccessEnabled() && access.status !== "active") {
    return { allowed: false, redirect: "/pending-access" };
  }

  if (!hasCapability(access.role, requiredCapability)) {
    return { allowed: false, redirect: "/unauthorized" };
  }

  return { allowed: true, access };
}

/**
 * Authoritative guard for authenticated-only pages (like Quote Desk).
 * Allows any active user but redirects pending/disabled.
 */
export async function requirePageAuth(): Promise<PageGuardResult> {
  const access = await resolvePageAccess();

  if (!access) {
    return { allowed: false, redirect: "/login" };
  }

  if (isUserAccessEnabled() && access.status !== "active") {
    return { allowed: false, redirect: "/pending-access" };
  }

  return { allowed: true, access };
}
