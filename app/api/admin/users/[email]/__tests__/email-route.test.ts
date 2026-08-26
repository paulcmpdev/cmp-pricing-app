import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

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

import { getUserAccessRepository } from "@/lib/server/user-access/repository";
import { getToken } from "next-auth/jwt";
import { GET, PATCH } from "../../[email]/route";

const mockGetRepo = vi.mocked(getUserAccessRepository);
const mockGetToken = vi.mocked(getToken);

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

function routeParams(email: string) {
  return { params: Promise.resolve({ email }) };
}

beforeEach(() => {
  env.CMP_AUTH_ENABLED = "true";
  env.CMP_USER_ACCESS_ENABLED = "true";
  env.CMP_ADMIN_EMAILS = "paul@cmpsportswear.com";
  env.CMP_ALLOWED_GOOGLE_DOMAIN = "cmpsportswear.com";
  mockGetRepo.mockReturnValue(defaultMockRepo as any);
  mockGetToken.mockResolvedValue({
    email: "paul@cmpsportswear.com",
    role: "admin",
  } as never);
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fix 6 regression: [email] route APIs fail closed when auth is disabled
// ---------------------------------------------------------------------------

describe("fail-closed when CMP_AUTH_ENABLED is false (Fix 6)", () => {
  it("GET returns 401 when auth is disabled", async () => {
    delete env.CMP_AUTH_ENABLED;
    const res = await GET(
      request("http://localhost/api/admin/users/test@cmpsportswear.com"),
      routeParams("test@cmpsportswear.com")
    );
    expect(res.status).toBe(401);
  });

  it("PATCH returns 401 when auth is disabled", async () => {
    delete env.CMP_AUTH_ENABLED;
    const res = await PATCH(
      request("http://localhost/api/admin/users/test@cmpsportswear.com", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          action: "approve",
          role: "sales_rep",
          expectedVersion: 1,
        }),
      }),
      routeParams("test@cmpsportswear.com")
    );
    expect(res.status).toBe(401);
  });

  it("GET returns 401 when CMP_AUTH_ENABLED=false even with CMP_USER_ACCESS_ENABLED=true", async () => {
    env.CMP_AUTH_ENABLED = "false";
    env.CMP_USER_ACCESS_ENABLED = "true";
    const res = await GET(
      request("http://localhost/api/admin/users/test@cmpsportswear.com"),
      routeParams("test@cmpsportswear.com")
    );
    expect(res.status).toBe(401);
  });
});

describe("route email validation", () => {
  it("PATCH rejects cross-origin mutations", async () => {
    const res = await PATCH(
      request("http://localhost/api/admin/users/user@cmpsportswear.com", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({
          action: "approve",
          role: "sales_rep",
          expectedVersion: 1,
        }),
      }),
      routeParams("user@cmpsportswear.com")
    );
    expect(res.status).toBe(403);
    expect(defaultMockRepo.approveUser).not.toHaveBeenCalled();
  });

  it.each(["user@gmail.com", "not-an-email", "%E0%A4%A"])(
    "GET rejects invalid route email %s",
    async (email) => {
      const res = await GET(
        request(`http://localhost/api/admin/users/${email}`),
        routeParams(email)
      );
      expect(res.status).toBe(400);
      expect(defaultMockRepo.getUser).not.toHaveBeenCalledWith(email);
    }
  );

  it("PATCH rejects a non-CMP route email before mutation", async () => {
    const res = await PATCH(
      request("http://localhost/api/admin/users/user@gmail.com", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          action: "approve",
          role: "sales_rep",
          expectedVersion: 1,
        }),
      }),
      routeParams("user@gmail.com")
    );
    expect(res.status).toBe(400);
    expect(defaultMockRepo.approveUser).not.toHaveBeenCalled();
  });
});
