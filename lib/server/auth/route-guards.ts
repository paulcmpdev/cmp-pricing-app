/**
 * Server-side route guard helpers for API routes and pages.
 *
 * These are authoritative guards - they remain enforced even if
 * middleware is bypassed.
 */
import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import {
  isAuthEnabled,
  resolveQuoteProjection,
  hasCapability,
  type CmpRole,
  type CmpCapability,
  type QuoteProjection,
} from "./policy";

export type AuthResult = {
  email: string;
  role: CmpRole;
};

function json401() {
  return NextResponse.json(
    { error: "Authentication required." },
    { status: 401 }
  );
}

function json403() {
  return NextResponse.json(
    { error: "Insufficient permissions." },
    { status: 403 }
  );
}

async function getSessionRole(
  request: NextRequest
): Promise<AuthResult | null> {
  const token = await getToken({ req: request });
  if (!token?.role || !token?.email) return null;
  return { email: token.email as string, role: token.role as CmpRole };
}

/**
 * Returns null if the request is authorized, or a 401 response.
 * When auth is disabled, always returns null (pass-through).
 */
export async function requireAuth(
  request: NextRequest
): Promise<NextResponse | null> {
  if (!isAuthEnabled()) return null;
  const session = await getSessionRole(request);
  if (!session) return json401();
  return null;
}

/**
 * Returns null if the request has the required capability, or 401/403.
 * When auth is disabled, always returns null (pass-through).
 */
export async function requireRole(
  request: NextRequest,
  requiredCapability: CmpCapability
): Promise<NextResponse | null> {
  if (!isAuthEnabled()) return null;
  const session = await getSessionRole(request);
  if (!session) return json401();
  if (!hasCapability(session.role, requiredCapability)) {
    return json403();
  }
  return null;
}

/**
 * Resolve the quote projection level for an authenticated request.
 *
 * When auth is enabled: uses JWT session role, ignores x-cmp-role.
 * When auth is disabled: falls back to legacy preview/local behavior.
 */
export async function resolveAuthenticatedProjection(
  request: NextRequest
): Promise<QuoteProjection> {
  if (isAuthEnabled()) {
    const session = await getSessionRole(request);
    return resolveQuoteProjection(session?.role ?? null);
  }

  // Legacy behavior: preview gate or local manager mode
  const { isAdditionalLocationsPreviewEnabled } = await import(
    "../pricing-preview-gate"
  );
  if (isAdditionalLocationsPreviewEnabled()) return "manager";

  const role = request.headers.get("x-cmp-role");
  const localManagerAllowed =
    role === "manager" &&
    process.env.NODE_ENV !== "production" &&
    process.env.CMP_ALLOW_LOCAL_MANAGER_MODE === "true";

  return localManagerAllowed ? "manager" : "staff";
}

/**
 * Get the authenticated session from a request (for page use).
 * Returns null if auth is disabled or no session.
 */
export async function getAuthSession(
  request: NextRequest
): Promise<AuthResult | null> {
  if (!isAuthEnabled()) return null;
  return getSessionRole(request);
}
