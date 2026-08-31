import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";

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
const ENV_KEYS = [
  "CMP_PRICING_CONFIG_ENABLED",
  "CMP_DATABASE_URL",
  "VENDOR_CATALOG_DATABASE_URL",
  "CMP_AUTH_ENABLED",
  "CMP_ALLOW_LOCAL_MANAGER_MODE",
];

function request(role?: "manager") {
  return new NextRequest(
    new Request("http://localhost/api/quote/options", {
      headers: role ? { "x-cmp-role": role } : undefined,
    })
  );
}

function version(configType: "dtf_matrix" | "additional_prints", data: unknown) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    configType,
    data,
    status: "active" as const,
    createdBy: "admin@cmpsportswear.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    activatedAt: "2026-01-01T00:00:00.000Z",
    supersededAt: null,
  };
}

const DTF_DATA = {
  lanes: [
    { key: "T1", label: "T1", margin: 0.5, active: true },
    { key: "T2", label: "T2", margin: 0.45, active: false },
  ],
  tiers: [{ tier: "1+", minQty: 1, maxQty: null, prices: { T1: 5 } }],
};

function baseService(overrides: Partial<Record<string, unknown>>) {
  return {
    key: "svc",
    name: "Service",
    description: "A service",
    type: "service",
    geometryKey: null,
    composition: [{ sizeKey: "FLAT_LARGE", quantityPerShirt: 1 }],
    cogs: 1,
    operatorOperatingCost: 0.1,
    enginePrice: 3,
    policyFloor: 0,
    manualOverride: null,
    effectivePrice: 3,
    grossMargin: 0.5,
    status: "Engine price",
    operatorMinPerShirt: 0,
    designerMinPerOrder: 0,
    active: true,
    sortOrder: 0,
    ...overrides,
  };
}

const AP_DATA = {
  services: [
    baseService({
      key: "sleeve_print",
      name: "Sleeve Print",
      description: "One standard sleeve print",
      geometryKey: "FLAT_SLEEVE",
      composition: [{ sizeKey: "FLAT_SLEEVE", quantityPerShirt: 1 }],
      cogs: 2.1,
      operatorOperatingCost: 0.19,
      enginePrice: 6,
      policyFloor: 5,
      effectivePrice: 6,
      grossMargin: 0.65,
      operatorMinPerShirt: 2,
      designerMinPerOrder: 5,
      sortOrder: 2,
    }),
    baseService({
      key: "inactive_service",
      name: "Inactive Service",
      description: "Should be filtered out",
      active: false,
      sortOrder: 1,
    }),
    baseService({
      key: "name_print",
      name: "Name",
      description: "One personalized name",
      geometryKey: "FLAT_NAME",
      composition: [{ sizeKey: "FLAT_NAME", quantityPerShirt: 1 }],
      cogs: 2.9,
      enginePrice: 7,
      effectivePrice: 7,
      sortOrder: 0,
    }),
  ],
  columns: [
    { key: "name", label: "Service", required: true, visible: true, order: 0 },
    { key: "effectivePrice", label: "Price", required: true, visible: true, order: 1 },
  ],
  minimumBillableQuantity: 12,
};

function repoWith(dtf: ReturnType<typeof version> | null, ap: ReturnType<typeof version> | null) {
  return {
    getActiveVersion: vi.fn(async (configType: "dtf_matrix" | "additional_prints") =>
      configType === "dtf_matrix" ? dtf : ap
    ),
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
  env.CMP_AUTH_ENABLED = "false";
  env.CMP_ALLOW_LOCAL_MANAGER_MODE = "true";
  mockDbConfigured.mockReturnValue(true);
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  vi.resetAllMocks();
});

describe("GET /api/quote/options — staff-safe projection", () => {
  it("grants the lane-override capability to the auth-disabled local Manager header", async () => {
    mockGetRepo.mockReturnValue(
      repoWith(version("dtf_matrix", DTF_DATA), version("additional_prints", AP_DATA)) as never
    );

    const res = await GET(request("manager"));
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.canOverridePricingLane).toBe(true);
  });

  it("returns only active lanes and services, sorted by sortOrder, with no COGS/margin/status/internal fields", async () => {
    mockGetRepo.mockReturnValue(
      repoWith(version("dtf_matrix", DTF_DATA), version("additional_prints", AP_DATA)) as never
    );

    const res = await GET(request());
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.lanes).toEqual([{ key: "T1", label: "T1" }]);
    expect(data.services).toHaveLength(2);
    // Inactive service filtered out; remaining two ordered by sortOrder (2, then 5),
    // not by their position in the stored array (sleeve_print appears first there).
    expect(data.services.map((s: { key: string }) => s.key)).toEqual([
      "name_print",
      "sleeve_print",
    ]);
    expect(data.services[1]).toEqual({
      key: "sleeve_print",
      name: "Sleeve Print",
      description: "One standard sleeve print",
      type: "service",
      effectivePrice: 6,
    });
    expect(data.minimumBillableQuantity).toBe(12);
    expect(data.canOverridePricingLane).toBe(false);

    const serialized = JSON.stringify(data);
    for (const internalField of ["cogs", "operatorOperatingCost", "enginePrice", "policyFloor", "manualOverride", "grossMargin", "status", "operatorMinPerShirt", "designerMinPerOrder", "geometryKey"]) {
      expect(serialized).not.toContain(internalField);
    }
  });

  it("returns 503 when the DTF config has no active version", async () => {
    mockGetRepo.mockReturnValue(repoWith(null, version("additional_prints", AP_DATA)) as never);
    const res = await GET(request());
    expect(res.status).toBe(503);
  });

  it("returns 503 when the Additional Prints config has no active version", async () => {
    mockGetRepo.mockReturnValue(repoWith(version("dtf_matrix", DTF_DATA), null) as never);
    const res = await GET(request());
    expect(res.status).toBe(503);
  });

  it("returns 503 when the pricing config database is unavailable", async () => {
    mockGetRepo.mockReturnValue({
      ...repoWith(null, null),
      getActiveVersion: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as never);
    const res = await GET(request());
    expect(res.status).toBe(503);
  });
});
