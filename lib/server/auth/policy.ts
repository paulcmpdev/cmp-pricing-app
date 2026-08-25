/**
 * CMP Auth Policy - Pure server-side authorization logic.
 *
 * Roles are derived from verified email addresses against env-configured
 * lists. No headers, no client input, no database.
 */

export type CmpRole = "admin" | "manager" | "sales_rep";
export type CmpCapability = "view_quotes" | "view_manager_projections" | "admin_access";
export type QuoteProjection = "staff" | "manager";

export function isAuthEnabled(env = process.env): boolean {
  return env.CMP_AUTH_ENABLED === "true";
}

export function isAllowedDomain(
  email: string | null | undefined,
  allowedDomain: string
): boolean {
  if (!email || typeof email !== "string") return false;
  const normalized = email.toLowerCase().trim();
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex < 1) return false;
  const domain = normalized.slice(atIndex + 1);
  return domain === allowedDomain.toLowerCase();
}

export function parseEmailList(csv: string | undefined): string[] {
  if (!csv) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of csv.split(",")) {
    const email = raw.trim().toLowerCase();
    if (email && !seen.has(email)) {
      seen.add(email);
      result.push(email);
    }
  }
  return result;
}

export function resolveRole(
  email: string | null | undefined,
  env = process.env
): CmpRole | null {
  if (!email || typeof email !== "string") return null;

  const allowedDomain = env.CMP_ALLOWED_GOOGLE_DOMAIN;
  if (!allowedDomain) return null;

  if (!isAllowedDomain(email, allowedDomain)) return null;

  const normalized = email.toLowerCase().trim();
  const adminEmails = parseEmailList(env.CMP_ADMIN_EMAILS);
  if (adminEmails.includes(normalized)) return "admin";

  const managerEmails = parseEmailList(env.CMP_MANAGER_EMAILS);
  if (managerEmails.includes(normalized)) return "manager";

  return "sales_rep";
}

const CAPABILITIES: Record<CmpCapability, Set<CmpRole>> = {
  view_quotes: new Set<CmpRole>(["admin", "manager", "sales_rep"]),
  view_manager_projections: new Set<CmpRole>(["admin", "manager"]),
  admin_access: new Set<CmpRole>(["admin"]),
};

export function hasCapability(
  role: CmpRole | null,
  capability: CmpCapability
): boolean {
  if (!role) return false;
  return CAPABILITIES[capability]?.has(role) ?? false;
}

export function resolveQuoteProjection(role: CmpRole | null): QuoteProjection {
  if (role && hasCapability(role, "view_manager_projections")) {
    return "manager";
  }
  return "staff";
}
