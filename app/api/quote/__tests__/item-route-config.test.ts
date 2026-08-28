import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../item/route";

vi.mock("@/lib/server/vendor-catalog/repository", () => ({
  getVendorCatalogStatus: vi.fn(),
  resolveCatalogVariantCost: vi.fn(),
}));

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
    new Request("http://localhost/api/quote/item", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cmp-role": "staff" },
      body: JSON.stringify(body),
    })
  );
}

function activeVersion(data: unknown) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    configType: "dtf_matrix" as const,
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

// A dynamic tier matrix distinct from the static contract fixture, so a
// passing price assertion proves the route used the *stored* config tiers,
// not the fallback contract.dtfEngine.tierPriceMatrix.
const CUSTOM_DYNAMIC_TIERS = [
  { tier: "1-9999", minQty: 1, maxQty: null, prices: { T2: 999 } },
];

describe("quote item route — dynamic pricing config", () => {
  it("defaults to the first active lane when tierPriceLane is omitted, even when it is not named T1", async () => {
    mockGetRepo.mockReturnValue(
      repoWithVersion(
        activeVersion({
          lanes: [
            { key: "T1", label: "T1", margin: 0.5, active: false },
            { key: "T2", label: "T2", margin: 0.45, active: true },
          ],
          tiers: CUSTOM_DYNAMIC_TIERS,
        })
      ) as never
    );

    const res = await POST(request({ productCost: 3.95, quantity: 84 }));
    expect(res.status).toBe(200);
    const data = await res.json();
    // decorationSell reflects the dynamic tier's T2 price (999), proving the
    // first *active* lane (T2, since T1 is inactive) was used as the default.
    expect(data.decorationSell).toBe(999);
  });

  it("uses stored dynamic tiers from the active config, not the static contract matrix", async () => {
    mockGetRepo.mockReturnValue(
      repoWithVersion(
        activeVersion({
          lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
          tiers: CUSTOM_DYNAMIC_TIERS.map((t) => ({ ...t, prices: { T1: 777 } })),
        })
      ) as never
    );

    const res = await POST(request({ productCost: 3.95, quantity: 84, tierPriceLane: "T1" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.decorationSell).toBe(777);
  });

  it("returns 422 when the requested lane exists but is not active", async () => {
    mockGetRepo.mockReturnValue(
      repoWithVersion(
        activeVersion({
          lanes: [
            { key: "T1", label: "T1", margin: 0.5, active: false },
            { key: "T2", label: "T2", margin: 0.45, active: true },
          ],
          tiers: CUSTOM_DYNAMIC_TIERS,
        })
      ) as never
    );

    const res = await POST(
      request({ productCost: 3.95, quantity: 84, tierPriceLane: "T1" })
    );
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error.tierPriceLane[0]).toContain("Unknown pricing lane");
  });

  it("returns 503 when no active DTF config version exists", async () => {
    mockGetRepo.mockReturnValue(repoWithVersion(null) as never);

    const res = await POST(request({ productCost: 3.95, quantity: 84 }));
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error._form[0]).toContain("No active dtf_matrix configuration");
  });

  it("returns 503 when the pricing config database is unavailable", async () => {
    mockGetRepo.mockReturnValue({
      ...repoWithVersion(null),
      getActiveVersion: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as never);

    const res = await POST(request({ productCost: 3.95, quantity: 84 }));
    expect(res.status).toBe(503);
  });
});
