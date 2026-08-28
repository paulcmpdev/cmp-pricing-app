import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../repository", () => ({
  getPricingConfigRepository: vi.fn(),
  isPricingConfigDatabaseConfigured: vi.fn(),
}));

import {
  getPricingConfigRepository,
  isPricingConfigDatabaseConfigured,
} from "../repository";
import { resolveActiveConfig } from "../resolver";

const mockGetRepo = vi.mocked(getPricingConfigRepository);
const mockDbConfigured = vi.mocked(isPricingConfigDatabaseConfigured);
const env = process.env as Record<string, string | undefined>;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CMP_PRICING_CONFIG_ENABLED"];

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = env[key];
  env.CMP_PRICING_CONFIG_ENABLED = "true";
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  vi.resetAllMocks();
});

describe("resolveActiveConfig", () => {
  it("applies schema defaults (operatorOperatingCost) to a stored row that predates the field", async () => {
    mockDbConfigured.mockReturnValue(true);
    const serviceMissingOperatingCost = {
      key: "legacy_service",
      name: "Legacy Service",
      description: "Saved before operatorOperatingCost existed",
      type: "service" as const,
      geometryKey: "FLAT_LARGE",
      composition: [{ sizeKey: "FLAT_LARGE", quantityPerShirt: 1 }],
      cogs: 2,
      // operatorOperatingCost intentionally omitted
      enginePrice: 5,
      policyFloor: 0,
      manualOverride: null,
      effectivePrice: 5,
      grossMargin: 0.5,
      status: "Engine price",
      operatorMinPerShirt: 0,
      designerMinPerOrder: 0,
      active: true,
      sortOrder: 0,
    };
    mockGetRepo.mockReturnValue({
      getActiveVersion: vi.fn().mockResolvedValue({
        id: "11111111-1111-1111-1111-111111111111",
        configType: "additional_prints",
        data: {
          services: [serviceMissingOperatingCost],
          columns: [
            { key: "name", label: "Service", required: true, visible: true, order: 0 },
            { key: "effectivePrice", label: "Price", required: true, visible: true, order: 1 },
          ],
          minimumBillableQuantity: 12,
        },
        status: "active",
        createdBy: "admin@cmpsportswear.com",
        createdAt: "2026-01-01T00:00:00.000Z",
        activatedAt: "2026-01-01T00:00:00.000Z",
        supersededAt: null,
      }),
      getVersion: vi.fn(),
      listVersions: vi.fn(),
      saveAndActivate: vi.fn(),
      activateVersion: vi.fn(),
    } as never);

    const result = await resolveActiveConfig("additional_prints");

    expect(result.ok).toBe(true);
    if (result.ok && result.source === "database") {
      const service = (result.version.data as { services: Array<{ operatorOperatingCost: number }> })
        .services[0];
      expect(service.operatorOperatingCost).toBe(0);
    }
  });
});
