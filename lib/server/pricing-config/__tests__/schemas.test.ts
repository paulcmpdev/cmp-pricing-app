import { describe, it, expect } from "vitest";
import {
  DtfMatrixConfigSchema,
  DtfLaneSchema,
  DtfTierSchema,
  AdditionalPrintsConfigSchema,
  AdditionalPrintServiceSchema,
  AdditionalPrintsColumnSchema,
  ServiceCompositionSchema,
  SavePricingConfigRequestSchema,
  ActivatePricingConfigRequestSchema,
  ColumnKeySchema,
  ALL_COLUMN_KEYS,
} from "../schemas";

describe("DtfMatrixConfigSchema", () => {
  const validConfig = {
    lanes: [
      { key: "T1", label: "T1", margin: 0.5, active: true },
      { key: "T2", label: "T2", margin: 0.45, active: true },
    ],
    tiers: [
      { tier: "1-10", minQty: 1, maxQty: 10, prices: { T1: 14.2, T2: 13.2 } },
      { tier: "11+", minQty: 11, maxQty: null, prices: { T1: 10.5, T2: 9.5 } },
    ],
  };

  it("accepts a valid config with open-ended final tier", () => {
    const result = DtfMatrixConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it("rejects duplicate lane keys", () => {
    const result = DtfMatrixConfigSchema.safeParse({
      lanes: [
        { key: "T1", label: "T1", margin: 0.5, active: true },
        { key: "T1", label: "T1 dup", margin: 0.4, active: true },
      ],
      tiers: [
        { tier: "1", minQty: 1, maxQty: null, prices: { T1: 14.2 } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects tiers with gaps", () => {
    const result = DtfMatrixConfigSchema.safeParse({
      lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
      tiers: [
        { tier: "1-5", minQty: 1, maxQty: 5, prices: { T1: 14 } },
        { tier: "10+", minQty: 10, maxQty: null, prices: { T1: 10 } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects tiers not starting at qty 1", () => {
    const result = DtfMatrixConfigSchema.safeParse({
      lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
      tiers: [
        { tier: "5+", minQty: 5, maxQty: null, prices: { T1: 14 } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects tier where maxQty < minQty", () => {
    const result = DtfMatrixConfigSchema.safeParse({
      lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
      tiers: [
        { tier: "bad", minQty: 10, maxQty: 5, prices: { T1: 14 } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects tier missing price for active lane", () => {
    const result = DtfMatrixConfigSchema.safeParse({
      lanes: [
        { key: "T1", label: "T1", margin: 0.5, active: true },
        { key: "T2", label: "T2", margin: 0.4, active: true },
      ],
      tiers: [
        { tier: "1+", minQty: 1, maxQty: null, prices: { T1: 14 } }, // missing T2
      ],
    });
    expect(result.success).toBe(false);
  });

  it("allows contiguous tiers with open-ended final", () => {
    const result = DtfMatrixConfigSchema.safeParse({
      lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
      tiers: [
        { tier: "1-5", minQty: 1, maxQty: 5, prices: { T1: 20 } },
        { tier: "6-10", minQty: 6, maxQty: 10, prices: { T1: 15 } },
        { tier: "11+", minQty: 11, maxQty: null, prices: { T1: 10 } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-final open-ended tier", () => {
    const result = DtfMatrixConfigSchema.safeParse({
      lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
      tiers: [
        { tier: "1+", minQty: 1, maxQty: null, prices: { T1: 20 } },
        { tier: "100+", minQty: 100, maxQty: null, prices: { T1: 10 } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects final tier that is not open-ended", () => {
    const result = DtfMatrixConfigSchema.safeParse({
      lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
      tiers: [
        { tier: "1-100", minQty: 1, maxQty: 100, prices: { T1: 14 } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("allows inactive lane without prices in tiers", () => {
    const result = DtfMatrixConfigSchema.safeParse({
      lanes: [
        { key: "T1", label: "T1", margin: 0.5, active: true },
        { key: "T2", label: "T2", margin: 0.4, active: false },
      ],
      tiers: [
        { tier: "1+", minQty: 1, maxQty: null, prices: { T1: 14 } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a tier price keyed by an undeclared lane (bounds the prices record to declared lanes)", () => {
    const result = DtfMatrixConfigSchema.safeParse({
      lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
      tiers: [
        { tier: "1+", minQty: 1, maxQty: null, prices: { T1: 14, GHOST_LANE: 5 } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a price record key longer than 20 characters", () => {
    const result = DtfMatrixConfigSchema.safeParse({
      lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
      tiers: [
        {
          tier: "1+",
          minQty: 1,
          maxQty: null,
          prices: { T1: 14, ["k".repeat(21)]: 5 },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects config with no active lanes", () => {
    const result = DtfMatrixConfigSchema.safeParse({
      lanes: [
        { key: "T1", label: "T1", margin: 0.5, active: false },
      ],
      tiers: [
        { tier: "1+", minQty: 1, maxQty: null, prices: {} },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown top-level property", () => {
    const result = DtfMatrixConfigSchema.safeParse({
      ...validConfig,
      unknownField: "should not be accepted",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown property on a lane", () => {
    const result = DtfLaneSchema.safeParse({
      key: "T1",
      label: "T1",
      margin: 0.5,
      active: true,
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown property on a tier (sibling to the bounded prices record)", () => {
    const result = DtfTierSchema.safeParse({
      tier: "1+",
      minQty: 1,
      maxQty: null,
      prices: { T1: 10 },
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown property nested via the full config (lane-level)", () => {
    const result = DtfMatrixConfigSchema.safeParse({
      lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true, extra: "nope" }],
      tiers: [{ tier: "1+", minQty: 1, maxQty: null, prices: { T1: 10 } }],
    });
    expect(result.success).toBe(false);
  });
});

describe("AdditionalPrintsConfigSchema", () => {
  const validConfig = {
    services: [
      {
        key: "test_service",
        name: "Test Service",
        description: "A test service",
        type: "service",
        geometryKey: "FLAT_LARGE",
        composition: [{ sizeKey: "FLAT_LARGE", quantityPerShirt: 1 }],
        cogs: 3.0,
        enginePrice: 8,
        policyFloor: 0,
        manualOverride: null,
        effectivePrice: 8,
        grossMargin: 0.625,
        status: "Engine price",
        operatorMinPerShirt: 0,
        designerMinPerOrder: 10,
        active: true,
        sortOrder: 0,
      },
    ],
    columns: [
      { key: "name", label: "Service", required: true, visible: true, order: 0 },
      { key: "effectivePrice", label: "Price", required: true, visible: true, order: 1 },
    ],
    minimumBillableQuantity: 12,
  };

  it("accepts a valid config", () => {
    const result = AdditionalPrintsConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it("accepts package type", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      services: [{ ...validConfig.services[0], type: "package" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid type", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      services: [{ ...validConfig.services[0], type: "unknown" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate service keys", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      services: [validConfig.services[0], validConfig.services[0]],
    });
    expect(result.success).toBe(false);
  });

  it("rejects hidden required column", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      columns: [
        { key: "name", label: "Service", required: true, visible: false, order: 0 },
        { key: "effectivePrice", label: "Price", required: true, visible: true, order: 1 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required column", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      columns: [
        { key: "effectivePrice", label: "Price", required: true, visible: true, order: 0 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects service with empty composition", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      services: [{ ...validConfig.services[0], composition: [] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects arbitrary column key", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      columns: [
        { key: "name", label: "Service", required: true, visible: true, order: 0 },
        { key: "effectivePrice", label: "Price", required: true, visible: true, order: 1 },
        { key: "arbitrary_key", label: "Bad", required: false, visible: true, order: 2 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts all supported column keys", () => {
    for (const key of ALL_COLUMN_KEYS) {
      const result = ColumnKeySchema.safeParse(key);
      expect(result.success).toBe(true);
    }
  });

  it("rejects non-contiguous sortOrder values", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      services: [
        { ...validConfig.services[0], key: "a", sortOrder: 0 },
        { ...validConfig.services[0], key: "b", sortOrder: 2 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate sortOrder values", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      services: [
        { ...validConfig.services[0], key: "a", sortOrder: 0 },
        { ...validConfig.services[0], key: "b", sortOrder: 0 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts sortOrder in any array order as long as the set is 0..n-1", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      services: [
        { ...validConfig.services[0], key: "a", sortOrder: 2 },
        { ...validConfig.services[0], key: "b", sortOrder: 0 },
        { ...validConfig.services[0], key: "c", sortOrder: 1 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects composition longer than 20 items", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      services: [
        {
          ...validConfig.services[0],
          composition: Array.from({ length: 21 }, (_, i) => ({
            sizeKey: `SIZE_${i}`,
            quantityPerShirt: 1,
          })),
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a sizeKey longer than 60 characters", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      services: [
        {
          ...validConfig.services[0],
          composition: [{ sizeKey: "s".repeat(61), quantityPerShirt: 1 }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a geometryKey longer than 60 characters", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      services: [{ ...validConfig.services[0], geometryKey: "g".repeat(61) }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string geometryKey (must be null or non-empty)", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      services: [{ ...validConfig.services[0], geometryKey: "" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a status longer than 100 characters", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      services: [{ ...validConfig.services[0], status: "s".repeat(101) }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown top-level property", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      unknownField: "should not be accepted",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown property on a service", () => {
    const result = AdditionalPrintServiceSchema.safeParse({
      ...validConfig.services[0],
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown property on a composition row", () => {
    const result = ServiceCompositionSchema.safeParse({
      sizeKey: "FLAT_LARGE",
      quantityPerShirt: 1,
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown property on a column", () => {
    const result = AdditionalPrintsColumnSchema.safeParse({
      key: "name",
      label: "Service",
      required: true,
      visible: true,
      order: 0,
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown property nested via the full config (service composition-level)", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      services: [
        {
          ...validConfig.services[0],
          composition: [{ sizeKey: "FLAT_LARGE", quantityPerShirt: 1, extra: "nope" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown property nested via the full config (column-level)", () => {
    const result = AdditionalPrintsConfigSchema.safeParse({
      ...validConfig,
      columns: [
        { key: "name", label: "Service", required: true, visible: true, order: 0, extra: "nope" },
        { key: "effectivePrice", label: "Price", required: true, visible: true, order: 1 },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("SavePricingConfigRequestSchema", () => {
  it("accepts dtf_matrix save request", () => {
    const result = SavePricingConfigRequestSchema.safeParse({
      configType: "dtf_matrix",
      data: {
        lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
        tiers: [{ tier: "1+", minQty: 1, maxQty: null, prices: { T1: 10 } }],
      },
      expectedVersion: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown config type", () => {
    const result = SavePricingConfigRequestSchema.safeParse({
      configType: "unknown",
      data: {},
      expectedVersion: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown top-level property alongside a valid dtf_matrix request", () => {
    const result = SavePricingConfigRequestSchema.safeParse({
      configType: "dtf_matrix",
      data: {
        lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
        tiers: [{ tier: "1+", minQty: 1, maxQty: null, prices: { T1: 10 } }],
      },
      expectedVersion: null,
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });
});

describe("ActivatePricingConfigRequestSchema", () => {
  it("accepts valid activation request", () => {
    const result = ActivatePricingConfigRequestSchema.safeParse({
      configType: "dtf_matrix",
      versionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      expectedCurrentVersionId: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-UUID versionId", () => {
    const result = ActivatePricingConfigRequestSchema.safeParse({
      configType: "dtf_matrix",
      versionId: "not-a-uuid",
      expectedCurrentVersionId: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown top-level property", () => {
    const result = ActivatePricingConfigRequestSchema.safeParse({
      configType: "dtf_matrix",
      versionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      expectedCurrentVersionId: null,
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });
});
