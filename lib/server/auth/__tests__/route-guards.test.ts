import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level auth guard tests.
 *
 * Tests the server-side guard helpers that protect API routes and pages.
 * Verifies 401/403 behavior, spoofed header rejection, and projection
 * selection based on authenticated role.
 */

import {
  requireAuth,
  requireRole,
  resolveAuthenticatedProjection,
} from "../route-guards";

// Mock next-auth/jwt
vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

import { getToken } from "next-auth/jwt";
const mockGetToken = vi.mocked(getToken);

const env = process.env as Record<string, string | undefined>;

const KEYS = [
  "CMP_AUTH_ENABLED",
  "CMP_ALLOWED_GOOGLE_DOMAIN",
  "CMP_ADMIN_EMAILS",
  "CMP_MANAGER_EMAILS",
  "CMP_ALLOW_LOCAL_MANAGER_MODE",
  "NODE_ENV",
] as const;

const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
  vi.resetAllMocks();
});

function enableAuth() {
  env.CMP_AUTH_ENABLED = "true";
  env.CMP_ALLOWED_GOOGLE_DOMAIN = "cmpsportswear.com";
  env.CMP_ADMIN_EMAILS = "paul@cmpsportswear.com";
  env.CMP_MANAGER_EMAILS = "jane@cmpsportswear.com";
}

function mockHeaders(extra: Record<string, string> = {}) {
  return new Headers({ "content-type": "application/json", ...extra });
}

// ---------------------------------------------------------------------------
// requireAuth
// ---------------------------------------------------------------------------

describe("requireAuth", () => {
  it("returns null (pass) when auth is disabled", async () => {
    delete env.CMP_AUTH_ENABLED;
    const result = await requireAuth({} as any);
    expect(result).toBeNull();
  });

  it("returns 401 when auth enabled but no session token", async () => {
    enableAuth();
    mockGetToken.mockResolvedValue(null);
    const result = await requireAuth({ headers: mockHeaders() } as any);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it("returns null (pass) when auth enabled and valid session", async () => {
    enableAuth();
    mockGetToken.mockResolvedValue({
      email: "paul@cmpsportswear.com",
      role: "admin",
    } as any);
    const result = await requireAuth({ headers: mockHeaders() } as any);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// requireRole
// ---------------------------------------------------------------------------

describe("requireRole", () => {
  it("returns null (pass) when auth is disabled", async () => {
    delete env.CMP_AUTH_ENABLED;
    const result = await requireRole({} as any, "admin_access");
    expect(result).toBeNull();
  });

  it("returns 401 when no session", async () => {
    enableAuth();
    mockGetToken.mockResolvedValue(null);
    const result = await requireRole({ headers: mockHeaders() } as any, "admin_access");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it("returns 403 when session exists but role insufficient", async () => {
    enableAuth();
    mockGetToken.mockResolvedValue({
      email: "rep@cmpsportswear.com",
      role: "sales_rep",
    } as any);
    const result = await requireRole({ headers: mockHeaders() } as any, "admin_access");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns null (pass) when session has required role", async () => {
    enableAuth();
    mockGetToken.mockResolvedValue({
      email: "paul@cmpsportswear.com",
      role: "admin",
    } as any);
    const result = await requireRole({ headers: mockHeaders() } as any, "admin_access");
    expect(result).toBeNull();
  });

  it("sales_rep cannot access admin APIs", async () => {
    enableAuth();
    mockGetToken.mockResolvedValue({
      email: "rep@cmpsportswear.com",
      role: "sales_rep",
    } as any);
    const result = await requireRole({ headers: mockHeaders() } as any, "admin_access");
    expect(result!.status).toBe(403);
  });

  it("manager cannot access admin APIs", async () => {
    enableAuth();
    mockGetToken.mockResolvedValue({
      email: "jane@cmpsportswear.com",
      role: "manager",
    } as any);
    const result = await requireRole({ headers: mockHeaders() } as any, "admin_access");
    expect(result!.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// resolveAuthenticatedProjection
// ---------------------------------------------------------------------------

describe("resolveAuthenticatedProjection", () => {
  it("returns 'staff' for sales_rep regardless of x-cmp-role header", async () => {
    enableAuth();
    mockGetToken.mockResolvedValue({
      email: "rep@cmpsportswear.com",
      role: "sales_rep",
    } as any);
    const req = {
      headers: mockHeaders({ "x-cmp-role": "manager" }),
    } as any;
    const result = await resolveAuthenticatedProjection(req);
    expect(result).toBe("staff");
  });

  it("returns 'manager' for admin role", async () => {
    enableAuth();
    mockGetToken.mockResolvedValue({
      email: "paul@cmpsportswear.com",
      role: "admin",
    } as any);
    const result = await resolveAuthenticatedProjection({
      headers: mockHeaders(),
    } as any);
    expect(result).toBe("manager");
  });

  it("returns 'manager' for manager role", async () => {
    enableAuth();
    mockGetToken.mockResolvedValue({
      email: "jane@cmpsportswear.com",
      role: "manager",
    } as any);
    const result = await resolveAuthenticatedProjection({
      headers: mockHeaders(),
    } as any);
    expect(result).toBe("manager");
  });

  it("spoofed x-cmp-role header cannot elevate sales_rep to manager", async () => {
    enableAuth();
    mockGetToken.mockResolvedValue({
      email: "rep@cmpsportswear.com",
      role: "sales_rep",
    } as any);
    const result = await resolveAuthenticatedProjection({
      headers: mockHeaders({ "x-cmp-role": "manager" }),
    } as any);
    expect(result).toBe("staff");
  });

  it("falls back to legacy behavior when auth is disabled", async () => {
    delete env.CMP_AUTH_ENABLED;
    env.NODE_ENV = "development";
    env.CMP_ALLOW_LOCAL_MANAGER_MODE = "true";
    const result = await resolveAuthenticatedProjection({
      headers: mockHeaders({ "x-cmp-role": "manager" }),
    } as any);
    // When auth disabled, legacy behavior applies
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Spoofed headers
// ---------------------------------------------------------------------------

describe("spoofed header protection", () => {
  it("x-cmp-role='admin' does not grant admin access when auth enabled", async () => {
    enableAuth();
    mockGetToken.mockResolvedValue({
      email: "rep@cmpsportswear.com",
      role: "sales_rep",
    } as any);
    const result = await requireRole(
      { headers: mockHeaders({ "x-cmp-role": "admin" }) } as any,
      "admin_access"
    );
    expect(result!.status).toBe(403);
  });

  it("x-cmp-role='manager' does not grant manager projections when auth enabled", async () => {
    enableAuth();
    mockGetToken.mockResolvedValue({
      email: "rep@cmpsportswear.com",
      role: "sales_rep",
    } as any);
    const result = await resolveAuthenticatedProjection({
      headers: mockHeaders({ "x-cmp-role": "manager" }),
    } as any);
    expect(result).toBe("staff");
  });
});
