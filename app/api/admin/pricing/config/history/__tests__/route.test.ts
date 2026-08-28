import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

vi.mock("@/lib/server/pricing-config/repository", () => ({
  getPricingConfigRepository: vi.fn(),
  isPricingConfigDatabaseConfigured: vi.fn(),
}));

import { getToken } from "next-auth/jwt";
import {
  getPricingConfigRepository,
  isPricingConfigDatabaseConfigured,
} from "@/lib/server/pricing-config/repository";
import { GET } from "../route";

const mockGetToken = vi.mocked(getToken);
const mockGetRepo = vi.mocked(getPricingConfigRepository);
const mockDbConfigured = vi.mocked(isPricingConfigDatabaseConfigured);
const env = process.env as Record<string, string | undefined>;

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "NODE_ENV",
  "VERCEL_ENV",
  "CMP_AUTH_ENABLED",
  "CMP_ENABLE_PRICING_PREVIEW",
  "CMP_PRICING_CONFIG_ENABLED",
  "CMP_DATABASE_URL",
  "VENDOR_CATALOG_DATABASE_URL",
];

const BASE_URL = "http://localhost/api/admin/pricing/config/history";

function request(url: string) {
  return new NextRequest(new Request(url));
}

function baseRepo() {
  return {
    getActiveVersion: vi.fn(),
    getVersion: vi.fn(),
    listVersions: vi.fn(),
    saveAndActivate: vi.fn(),
    activateVersion: vi.fn(),
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = env[key];
  }
  env.NODE_ENV = "test";
  delete env.VERCEL_ENV;
  env.CMP_AUTH_ENABLED = "true";
  env.CMP_ENABLE_PRICING_PREVIEW = "true";
  env.CMP_PRICING_CONFIG_ENABLED = "true";
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  vi.resetAllMocks();
});

describe("GET /api/admin/pricing/config/history", () => {
  it("returns 403 when auth is disabled, even though requireRole would pass through", async () => {
    env.CMP_AUTH_ENABLED = "false";
    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Authentication must be enabled");
    // Never reaches the token check or the repository — no actor emails leak.
    expect(mockGetToken).not.toHaveBeenCalled();
    expect(mockGetRepo).not.toHaveBeenCalled();
  });

  it("returns 401 for unauthenticated request", async () => {
    mockGetToken.mockResolvedValue(null);
    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    mockGetToken.mockResolvedValue({ email: "rep@cmpsportswear.com", role: "sales_rep" } as never);
    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    expect(res.status).toBe(403);
  });

  it("returns 404 when persistence is disabled", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "false";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    expect(res.status).toBe(404);
  });

  it("returns 404 for Preview-only mode (persistence disabled) even when auth is disabled", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "false";
    env.CMP_AUTH_ENABLED = "false";
    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    expect(res.status).toBe(404);
    // Never reaches the token check or the repository — no actor emails leak.
    expect(mockGetToken).not.toHaveBeenCalled();
    expect(mockGetRepo).not.toHaveBeenCalled();
  });

  it("returns 400 for missing type parameter", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const res = await GET(request(BASE_URL));
    expect(res.status).toBe(400);
  });

  it("returns 503 when the database is not configured", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(false);
    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    expect(res.status).toBe(503);
  });

  it("returns metadata-only version history, newest first, without leaking snapshot data", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(true);
    const listVersions = vi.fn().mockResolvedValue([
      {
        id: "22222222-2222-2222-2222-222222222222",
        configType: "dtf_matrix",
        data: { lanes: [], tiers: [] },
        status: "active",
        createdBy: "admin@cmpsportswear.com",
        createdAt: "2026-02-01T00:00:00.000Z",
        activatedAt: "2026-02-01T00:00:00.000Z",
        supersededAt: null,
      },
      {
        id: "11111111-1111-1111-1111-111111111111",
        configType: "dtf_matrix",
        data: { lanes: [], tiers: [] },
        status: "superseded",
        createdBy: "admin@cmpsportswear.com",
        createdAt: "2026-01-01T00:00:00.000Z",
        activatedAt: "2026-01-01T00:00:00.000Z",
        supersededAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
    mockGetRepo.mockReturnValue(baseRepo() as never);
    mockGetRepo.mockReturnValue({ ...baseRepo(), listVersions } as never);

    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0].id).toBe("22222222-2222-2222-2222-222222222222");
    for (const v of body.versions) {
      expect(v.data).toBeUndefined();
      expect(Object.keys(v).sort()).toEqual(
        ["activatedAt", "createdAt", "createdBy", "id", "status", "supersededAt"].sort()
      );
    }
    expect(listVersions).toHaveBeenCalledWith("dtf_matrix", 20);
  });

  it("returns 503 when the repository throws", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(true);
    mockGetRepo.mockReturnValue({
      ...baseRepo(),
      listVersions: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as never);

    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    expect(res.status).toBe(503);
  });
});
