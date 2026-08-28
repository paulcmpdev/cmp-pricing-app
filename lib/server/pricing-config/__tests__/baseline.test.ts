import { describe, it, expect } from "vitest";
import { getBaselineDtfMatrix, getBaselineAdditionalPrints } from "../baseline";
import { DtfMatrixConfigSchema, AdditionalPrintsConfigSchema } from "../schemas";

describe("baseline DTF matrix", () => {
  const baseline = getBaselineDtfMatrix();

  it("passes Zod validation", () => {
    const result = DtfMatrixConfigSchema.safeParse(baseline);
    expect(result.success).toBe(true);
  });

  it("has exactly 4 lanes (T1-T4)", () => {
    expect(baseline.lanes).toHaveLength(4);
    expect(baseline.lanes.map((l) => l.key)).toEqual(["T1", "T2", "T3", "T4"]);
  });

  it("lanes have correct margins", () => {
    expect(baseline.lanes[0].margin).toBe(0.5);
    expect(baseline.lanes[1].margin).toBe(0.45);
    expect(baseline.lanes[2].margin).toBe(0.4);
    expect(baseline.lanes[3].margin).toBe(0.35);
  });

  it("all lanes are active", () => {
    expect(baseline.lanes.every((l) => l.active)).toBe(true);
  });

  it("tiers are contiguous", () => {
    for (let i = 0; i < baseline.tiers.length - 1; i++) {
      expect(baseline.tiers[i].maxQty).not.toBeNull();
      expect(baseline.tiers[i + 1].minQty).toBe(baseline.tiers[i].maxQty! + 1);
    }
  });

  it("first tier starts at qty 1", () => {
    expect(baseline.tiers[0].minQty).toBe(1);
  });

  it("final tier is open-ended (maxQty: null)", () => {
    const lastTier = baseline.tiers[baseline.tiers.length - 1];
    expect(lastTier.maxQty).toBeNull();
  });

  it("tier prices include all four lane keys", () => {
    for (const tier of baseline.tiers) {
      expect(tier.prices.T1).toBeDefined();
      expect(tier.prices.T2).toBeDefined();
      expect(tier.prices.T3).toBeDefined();
      expect(tier.prices.T4).toBeDefined();
    }
  });
});

describe("baseline additional prints", () => {
  const baseline = getBaselineAdditionalPrints();

  it("passes Zod validation", () => {
    const result = AdditionalPrintsConfigSchema.safeParse(baseline);
    expect(result.success).toBe(true);
  });

  it("has exactly 9 services", () => {
    expect(baseline.services).toHaveLength(9);
  });

  it("has unique service keys", () => {
    const keys = baseline.services.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("all services are active", () => {
    expect(baseline.services.every((s) => s.active)).toBe(true);
  });

  it("all services have a valid type", () => {
    for (const svc of baseline.services) {
      expect(["service", "package"]).toContain(svc.type);
    }
  });

  it("minimum billable quantity is 12", () => {
    expect(baseline.minimumBillableQuantity).toBe(12);
  });

  it("has required columns visible", () => {
    const nameCol = baseline.columns.find((c) => c.key === "name");
    const priceCol = baseline.columns.find((c) => c.key === "effectivePrice");
    expect(nameCol?.required).toBe(true);
    expect(nameCol?.visible).toBe(true);
    expect(priceCol?.required).toBe(true);
    expect(priceCol?.visible).toBe(true);
  });

  describe("workbook baseline values", () => {
    const svc = (key: string) =>
      baseline.services.find((s) => s.key === key)!;

    it("Additional Large Print: $5 effective price", () => {
      const s = svc("additional_large_print");
      expect(s.name).toBe("Additional Large Print");
      expect(s.type).toBe("service");
      expect(s.manualOverride).toBe(5);
      expect(s.effectivePrice).toBe(5);
    });

    it("Sleeve Print: $6 effective price", () => {
      const s = svc("sleeve_print");
      expect(s.type).toBe("service");
      expect(s.effectivePrice).toBe(6);
      expect(s.policyFloor).toBe(5);
      expect(s.operatorMinPerShirt).toBe(2);
    });

    it("Bottom / Upper Chest: $4 effective price", () => {
      const s = svc("bottom_upper_chest");
      expect(s.effectivePrice).toBe(4);
    });

    it("Vertical Print: $7 effective price", () => {
      const s = svc("vertical_print");
      expect(s.effectivePrice).toBe(7);
    });

    it("Name: $7 effective price", () => {
      const s = svc("name");
      expect(s.effectivePrice).toBe(7);
    });

    it("Number: $7 effective price", () => {
      const s = svc("number");
      expect(s.effectivePrice).toBe(7);
    });

    it("Name + Number: $12 effective price", () => {
      const s = svc("name_number");
      expect(s.type).toBe("package");
      expect(s.effectivePrice).toBe(12);
      expect(s.geometryKey).toBeNull();
      expect(s.composition).toHaveLength(2);
    });

    it("Standard Package: $8 effective price", () => {
      const s = svc("standard_package");
      expect(s.type).toBe("package");
      expect(s.effectivePrice).toBe(8);
    });

    it("Premium Package: $20 effective price (manual override)", () => {
      const s = svc("premium_package");
      expect(s.type).toBe("package");
      expect(s.manualOverride).toBe(20);
      expect(s.effectivePrice).toBe(20);
    });

    it("all services have valid compositions", () => {
      for (const s of baseline.services) {
        expect(s.composition.length).toBeGreaterThan(0);
        for (const comp of s.composition) {
          expect(comp.sizeKey).toBeTruthy();
          expect(comp.quantityPerShirt).toBeGreaterThan(0);
        }
      }
    });
  });
});
