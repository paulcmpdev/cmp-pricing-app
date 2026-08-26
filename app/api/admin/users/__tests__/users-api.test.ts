import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

// Default mock repository used by route-guards for access resolution
const defaultMockRepo = {
  getUser: vi.fn().mockResolvedValue(null),
  listUsers: vi.fn().mockResolvedValue([]),
  getUserEvents: vi.fn().mockResolvedValue([]),
  getSummaryCounts: vi.fn().mockResolvedValue({ pending: 0, active: 0, disabled: 0, admins: 0 }),
  requestAccess: vi.fn(),
  preAuthorize: vi.fn(),
  approveUser: vi.fn(),
  changeRole: vi.fn(),
  disableUser: vi.fn(),
  reEnableUser: vi.fn(),
};

vi.mock("@/lib/server/user-access/repository", () => ({
  getUserAccessRepository: vi.fn(() => defaultMockRepo),
  isUserAccessDatabaseConfigured: vi.fn(() => true),
}));

import { getToken } from "next-auth/jwt";
import { getUserAccessRepository } from "@/lib/server/user-access/repository";
import { GET, POST } from "../route";

const mockGetToken = vi.mocked(getToken);
const mockGetRepo = vi.mocked(getUserAccessRepository);

const env = process.env as Record<string, string | undefined>;
const original: Record<string, string | undefined> = {};
const KEYS = [
  "CMP_AUTH_ENABLED",
  "CMP_USER_ACCESS_ENABLED",
  "CMP_ADMIN_EMAILS",
  "CMP_ALLOWED_GOOGLE_DOMAIN",
] as const;

for (const k of KEYS) original[k] = env[k];

function request(url: string, init?: RequestInit) {
  return new NextRequest(new Request(url, init));
}

beforeEach(() => {
  env.CMP_AUTH_ENABLED = "true";
  env.CMP_USER_ACCESS_ENABLED = "true";
  env.CMP_ADMIN_EMAILS = "paul@cmpsportswear.com";
  env.CMP_ALLOWED_GOOGLE_DOMAIN = "cmpsportswear.com";
  mockGetRepo.mockReturnValue(defaultMockRepo as any);
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  vi.clearAllMocks();
});

describe("GET /api/admin/users", () => {
  it("returns 401 for unauthenticated requests", async () => {
    mockGetToken.mockResolvedValue(null);
    const res = await GET(request("http://localhost/api/admin/users"));
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    mockGetToken.mockResolvedValue({
      email: "rep@cmpsportswear.com",
      role: "sales_rep",
    } as never);
    // Provide an active sales_rep DB record so session resolves
    defaultMockRepo.getUser.mockResolvedValueOnce({
      email: "rep@cmpsportswear.com",
      role: "sales_rep",
      status: "active",
      version: 1,
    });
    const res = await GET(request("http://localhost/api/admin/users"));
    expect(res.status).toBe(403);
  });

  it("returns users list for admin", async () => {
    mockGetToken.mockResolvedValue({
      email: "paul@cmpsportswear.com",
      role: "admin",
    } as never);

    const mockRepo = {
      ...defaultMockRepo,
      listUsers: vi.fn().mockResolvedValue([
        {
          email: "user@cmpsportswear.com",
          name: "User",
          image: null,
          role: "sales_rep",
          status: "active",
          version: 1,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          lastSignInAt: null,
        },
      ]),
      getSummaryCounts: vi.fn().mockResolvedValue({
        pending: 0,
        active: 1,
        disabled: 0,
        admins: 0,
      }),
    };
    mockGetRepo.mockReturnValue(mockRepo as any);

    const res = await GET(request("http://localhost/api/admin/users"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.users).toHaveLength(2); // 1 DB user + 1 bootstrap admin projection
    expect(data.counts.admins).toBe(1);
  });
});

describe("POST /api/admin/users (pre-authorize)", () => {
  it("rejects an oversized streamed body without Content-Length", async () => {
    mockGetToken.mockResolvedValue({
      email: "paul@cmpsportswear.com",
      role: "admin",
    } as never);
    const res = await POST(
      request("http://localhost/api/admin/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({ email: `${"a".repeat(17_000)}@cmpsportswear.com` }),
      })
    );
    expect(res.status).toBe(413);
    expect(defaultMockRepo.preAuthorize).not.toHaveBeenCalled();
  });

  it("rejects cross-origin mutations", async () => {
    mockGetToken.mockResolvedValue({
      email: "paul@cmpsportswear.com",
      role: "admin",
    } as never);
    const res = await POST(
      request("http://localhost/api/admin/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({
          email: "new@cmpsportswear.com",
          role: "sales_rep",
        }),
      })
    );
    expect(res.status).toBe(403);
    expect(defaultMockRepo.preAuthorize).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid email domain", async () => {
    mockGetToken.mockResolvedValue({
      email: "paul@cmpsportswear.com",
      role: "admin",
    } as never);

    const res = await POST(
      request("http://localhost/api/admin/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({ email: "user@evil.com", role: "sales_rep" }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid role", async () => {
    mockGetToken.mockResolvedValue({
      email: "paul@cmpsportswear.com",
      role: "admin",
    } as never);

    const res = await POST(
      request("http://localhost/api/admin/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          email: "user@cmpsportswear.com",
          role: "superadmin",
        }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 201 for valid pre-authorization", async () => {
    mockGetToken.mockResolvedValue({
      email: "paul@cmpsportswear.com",
      role: "admin",
    } as never);

    const mockRepo = {
      ...defaultMockRepo,
      preAuthorize: vi.fn().mockResolvedValue({
        ok: true,
        user: {
          email: "new@cmpsportswear.com",
          role: "sales_rep",
          status: "active",
          version: 1,
        },
        event: { id: "evt1", action: "pre_authorized" },
      }),
    };
    mockGetRepo.mockReturnValue(mockRepo as any);

    const res = await POST(
      request("http://localhost/api/admin/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          email: "new@cmpsportswear.com",
          role: "sales_rep",
        }),
      })
    );
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Fix 6 regression: APIs fail closed when CMP_AUTH_ENABLED is false
// ---------------------------------------------------------------------------

describe("fail-closed when CMP_AUTH_ENABLED is false (Fix 6)", () => {
  it("GET returns 401 when auth is disabled", async () => {
    delete env.CMP_AUTH_ENABLED;
    const res = await GET(request("http://localhost/api/admin/users"));
    expect(res.status).toBe(401);
  });

  it("POST returns 401 when auth is disabled", async () => {
    delete env.CMP_AUTH_ENABLED;
    const res = await POST(
      request("http://localhost/api/admin/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({ email: "test@cmpsportswear.com", role: "sales_rep" }),
      })
    );
    expect(res.status).toBe(401);
  });

  it("GET returns 401 when CMP_AUTH_ENABLED=false even with CMP_USER_ACCESS_ENABLED=true", async () => {
    env.CMP_AUTH_ENABLED = "false";
    env.CMP_USER_ACCESS_ENABLED = "true";
    const res = await GET(request("http://localhost/api/admin/users"));
    expect(res.status).toBe(401);
  });
});
