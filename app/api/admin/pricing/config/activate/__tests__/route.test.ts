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
import { POST } from "../route";

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

const BASE_URL = "http://localhost/api/admin/pricing/config/activate";
const VERSION_ID = "11111111-1111-1111-1111-111111111111";
const PRIOR_VERSION_ID = "22222222-2222-2222-2222-222222222222";

const SAMPLE_VERSION = {
  id: VERSION_ID,
  configType: "dtf_matrix" as const,
  data: {
    lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
    tiers: [{ tier: "1+", minQty: 1, maxQty: null, prices: { T1: 5 } }],
  },
  status: "active" as const,
  createdBy: "admin@cmpsportswear.com",
  createdAt: "2026-01-01T00:00:00.000Z",
  activatedAt: "2026-01-01T00:00:00.000Z",
  supersededAt: null,
};

function request(body?: unknown, headers?: Record<string, string>) {
  return new NextRequest(
    new Request(BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        ...headers,
      },
      body: JSON.stringify(body ?? {}),
    })
  );
}

function validBody(overrides?: Partial<Record<string, unknown>>) {
  return {
    configType: "dtf_matrix",
    versionId: VERSION_ID,
    expectedCurrentVersionId: PRIOR_VERSION_ID,
    ...overrides,
  };
}

function repo(overrides?: Partial<ReturnType<typeof baseRepo>>) {
  return { ...baseRepo(), ...overrides };
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

describe("POST /api/admin/pricing/config/activate", () => {
  it("returns 403 when auth is disabled", async () => {
    env.CMP_AUTH_ENABLED = "false";
    const res = await POST(request(validBody()));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Authentication must be enabled");
  });

  it("returns 401 for unauthenticated request", async () => {
    mockGetToken.mockResolvedValue(null);
    const res = await POST(request(validBody()));
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    mockGetToken.mockResolvedValue({ email: "rep@cmpsportswear.com", role: "sales_rep" } as never);
    const res = await POST(request(validBody()));
    expect(res.status).toBe(403);
  });

  it("returns 404 when persistence is disabled", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "false";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const res = await POST(request(validBody()));
    expect(res.status).toBe(404);
  });

  it("returns 403 for cross-origin request", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const res = await POST(
      request(validBody(), { Origin: "http://evil.com" })
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 for malformed JSON", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const res = await POST(
      new NextRequest(
        new Request(BASE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "http://localhost" },
          body: "not valid json{",
        })
      )
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid schema (non-uuid versionId)", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const res = await POST(request(validBody({ versionId: "not-a-uuid" })));
    expect(res.status).toBe(400);
  });

  it("returns 401 when the token has no email (requireRole treats it as unauthenticated)", async () => {
    mockGetToken.mockResolvedValue({ role: "admin" } as never);
    const res = await POST(request(validBody()));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Authentication required");
  });

  it("returns 503 when the database is not configured", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(false);
    const res = await POST(request(validBody()));
    expect(res.status).toBe(503);
  });

  it("activates a prior version, returning its new immutable copy metadata", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(true);
    const activateVersion = vi.fn().mockResolvedValue({ ok: true, version: SAMPLE_VERSION });
    mockGetRepo.mockReturnValue(repo({ activateVersion }) as never);

    const res = await POST(request(validBody()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.version.id).toBe(SAMPLE_VERSION.id);
    expect(activateVersion).toHaveBeenCalledWith(
      "dtf_matrix",
      VERSION_ID,
      PRIOR_VERSION_ID,
      "admin@cmpsportswear.com"
    );
  });

  it("returns 404 when the target version does not exist", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(true);
    mockGetRepo.mockReturnValue(
      repo({
        activateVersion: vi.fn().mockResolvedValue({
          ok: false,
          reason: "not_found",
          message: "Version not found.",
        }),
      }) as never
    );

    const res = await POST(request(validBody()));
    expect(res.status).toBe(404);
  });

  it("returns 409 when the target version is already active", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(true);
    mockGetRepo.mockReturnValue(
      repo({
        activateVersion: vi.fn().mockResolvedValue({
          ok: false,
          reason: "already_active",
          message: "Version is already active.",
        }),
      }) as never
    );

    const res = await POST(request(validBody()));
    expect(res.status).toBe(409);
  });

  it("returns 409 when the active version has changed concurrently", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(true);
    mockGetRepo.mockReturnValue(
      repo({
        activateVersion: vi.fn().mockResolvedValue({
          ok: false,
          reason: "conflict",
          message: "Expected active version mismatch.",
        }),
      }) as never
    );

    const res = await POST(request(validBody()));
    expect(res.status).toBe(409);
  });

  it("returns 422 when the historical target fails current schema validation", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(true);
    mockGetRepo.mockReturnValue(
      repo({
        activateVersion: vi.fn().mockResolvedValue({
          ok: false,
          reason: "invalid_snapshot",
          message: "Historical version no longer conforms to the current dtf_matrix schema: ...",
        }),
      }) as never
    );

    const res = await POST(request(validBody()));
    expect(res.status).toBe(422);
  });

  it("returns 503 when the repository throws", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(true);
    mockGetRepo.mockReturnValue(
      repo({ activateVersion: vi.fn().mockRejectedValue(new Error("connection refused")) }) as never
    );

    const res = await POST(request(validBody()));
    expect(res.status).toBe(503);
  });
});
