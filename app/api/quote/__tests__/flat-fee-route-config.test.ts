import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../flat-fee/route";

vi.mock("@/lib/server/pricing-config/repository", () => ({
  getPricingConfigRepository: vi.fn(),
  isPricingConfigDatabaseConfigured: vi.fn(),
}));

import {
  getPricingConfigRepository,
  isPricingConfigDatabaseConfigured,
} from "@/lib/server/pricing-config/repository";

const mockGetRepo = vi.mocked(getPricingConfigRepository);
const mockDbConfigured = vi.mocked(isPricingConfigDatabaseConfigured);
const env = process.env as Record<string, string | undefined>;

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CMP_PRICING_CONFIG_ENABLED", "CMP_DATABASE_URL", "VENDOR_CATALOG_DATABASE_URL"];

function request(body: unknown) {
  return new NextRequest(
    new Request("http://localhost/api/quote/flat-fee", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cmp-role": "staff" },
      body: JSON.stringify(body),
    })
  );
}

function activeVersion(data: unknown) {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    configType: "additional_prints" as const,
    data,
    status: "active" as const,
    createdBy: "admin@cmpsportswear.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    activatedAt: "2026-01-01T00:00:00.000Z",
    supersededAt: null,
  };
}

function repoWithVersion(version: ReturnType<typeof activeVersion> | null) {
  return {
    getActiveVersion: vi.fn().mockResolvedValue(version),
    getVersion: vi.fn(),
    listVersions: vi.fn(),
    saveAndActivate: vi.fn(),
    activateVersion: vi.fn(),
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = env[key];
  env.CMP_PRICING_CONFIG_ENABLED = "true";
  env.CMP_DATABASE_URL = "postgres://user:pass@localhost:5432/db";
  mockDbConfigured.mockReturnValue(true);
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  vi.resetAllMocks();
});

describe("quote flat-fee route — dynamic pricing config", () => {
  it("returns 503 when no active additional_prints config version exists", async () => {
    mockGetRepo.mockReturnValue(repoWithVersion(null) as never);

    const res = await POST(request({ service: "sleeve_print", orderQuantity: 84 }));
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error._form[0]).toContain("No active additional_prints configuration");
  });

  it("returns 503 when the pricing config database is unavailable", async () => {
    mockGetRepo.mockReturnValue({
      ...repoWithVersion(null),
      getActiveVersion: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as never);

    const res = await POST(request({ service: "sleeve_print", orderQuantity: 84 }));
    expect(res.status).toBe(503);
  });
});
