import { describe, it, expect } from "vitest";
import { calculatePooledFlatFee } from "../pooled-flat-fee-engine";
import { getPooledScenario } from "@/lib/fixtures/parity-scenario-types";

const EPSILON = 1e-9;

describe("pooled-additional-large-print-q12 parity", () => {
  const { inputs, expected } = getPooledScenario("pooled-additional-large-print-q12");

  const result = calculatePooledFlatFee({
    service: inputs.service,
    quantity: inputs.quantity,
  });

  it("service name", () => {
    expect(result.service).toBe(expected["Service"]);
  });

  it("quantity", () => {
    expect(result.quantity).toBe(expected["Qty"]);
  });

  it("unique groups", () => {
    expect(result.uniqueGroups).toBe(expected["Unique Groups"]);
  });

  it("pooled length", () => {
    expect(Math.abs(result.pooledLength - expected["Pooled Length"])).toBeLessThan(EPSILON);
  });

  it("pooled purchase", () => {
    expect(Math.abs(result.pooledPurchase - expected["Pooled Purchase"])).toBeLessThan(EPSILON);
  });

  it("base length", () => {
    expect(Math.abs(result.baseLength - expected["Base Length"])).toBeLessThan(EPSILON);
  });

  it("base purchase", () => {
    expect(Math.abs(result.basePurchase - expected["Base Purchase"])).toBeLessThan(EPSILON);
  });

  it("add-on placements per shirt", () => {
    expect(result.addOnPlacementsPerShirt).toBe(expected["Add-On Placements / Shirt"]);
  });

  it("incremental material per shirt", () => {
    expect(
      Math.abs(result.incrementalMaterialPerShirt - expected["Incremental Material / Shirt"])
    ).toBeLessThan(EPSILON);
  });

  it("operator operating cost", () => {
    expect(
      Math.abs(result.operatorOperatingCost - expected["Operator Operating Cost"])
    ).toBeLessThan(EPSILON);
  });

  it("extra operator labor", () => {
    expect(
      Math.abs(result.extraOperatorLabor - expected["Extra Operator Labor"])
    ).toBeLessThan(EPSILON);
  });

  it("designer labor", () => {
    expect(
      Math.abs(result.designerLabor - expected["Designer Labor"])
    ).toBeLessThan(EPSILON);
  });

  it("incremental COGS per shirt", () => {
    expect(
      Math.abs(result.incrementalCogsPerShirt - expected["Incremental COGS / Shirt"])
    ).toBeLessThan(EPSILON);
  });

  it("T1 price", () => {
    expect(
      Math.abs(result.t1Price - expected["T1 Price"])
    ).toBeLessThan(EPSILON);
  });

  it("engine whole dollar", () => {
    expect(result.engineWhole).toBe(expected["Engine Whole"]);
  });
});

describe("pooled-additional-large-print-q23 parity", () => {
  const { inputs, expected } = getPooledScenario("pooled-additional-large-print-q23");

  const result = calculatePooledFlatFee({
    service: inputs.service,
    quantity: inputs.quantity,
  });

  it("service name", () => {
    expect(result.service).toBe(expected["Service"]);
  });

  it("quantity", () => {
    expect(result.quantity).toBe(expected["Qty"]);
  });

  it("unique groups", () => {
    expect(result.uniqueGroups).toBe(expected["Unique Groups"]);
  });

  it("pooled length", () => {
    expect(Math.abs(result.pooledLength - expected["Pooled Length"])).toBeLessThan(EPSILON);
  });

  it("pooled purchase", () => {
    expect(Math.abs(result.pooledPurchase - expected["Pooled Purchase"])).toBeLessThan(EPSILON);
  });

  it("base length", () => {
    expect(Math.abs(result.baseLength - expected["Base Length"])).toBeLessThan(EPSILON);
  });

  it("base purchase", () => {
    expect(Math.abs(result.basePurchase - expected["Base Purchase"])).toBeLessThan(EPSILON);
  });

  it("add-on placements per shirt", () => {
    expect(result.addOnPlacementsPerShirt).toBe(expected["Add-On Placements / Shirt"]);
  });

  it("incremental material per shirt", () => {
    expect(
      Math.abs(result.incrementalMaterialPerShirt - expected["Incremental Material / Shirt"])
    ).toBeLessThan(EPSILON);
  });

  it("operator operating cost", () => {
    expect(
      Math.abs(result.operatorOperatingCost - expected["Operator Operating Cost"])
    ).toBeLessThan(EPSILON);
  });

  it("extra operator labor", () => {
    expect(
      Math.abs(result.extraOperatorLabor - expected["Extra Operator Labor"])
    ).toBeLessThan(EPSILON);
  });

  it("designer labor", () => {
    expect(
      Math.abs(result.designerLabor - expected["Designer Labor"])
    ).toBeLessThan(EPSILON);
  });

  it("incremental COGS per shirt", () => {
    expect(
      Math.abs(result.incrementalCogsPerShirt - expected["Incremental COGS / Shirt"])
    ).toBeLessThan(EPSILON);
  });

  it("T1 price", () => {
    expect(
      Math.abs(result.t1Price - expected["T1 Price"])
    ).toBeLessThan(EPSILON);
  });

  it("engine whole dollar", () => {
    expect(result.engineWhole).toBe(expected["Engine Whole"]);
  });
});

const ADDITIONAL_SCENARIOS = [
  "pooled-sleeve-print-q12",
  "pooled-sleeve-print-q16",
  "pooled-name-number-q12",
  "pooled-name-number-q23",
  "pooled-premium-package-q12",
  "pooled-premium-package-q23",
] as const;

for (const scenarioId of ADDITIONAL_SCENARIOS) {
  describe(`${scenarioId} parity`, () => {
    const { inputs, expected } = getPooledScenario(scenarioId);

    const result = calculatePooledFlatFee({
      service: inputs.service,
      quantity: inputs.quantity,
    });

    it("service name", () => {
      expect(result.service).toBe(expected["Service"]);
    });

    it("quantity", () => {
      expect(result.quantity).toBe(expected["Qty"]);
    });

    it("unique groups", () => {
      expect(result.uniqueGroups).toBe(expected["Unique Groups"]);
    });

    it("pooled length", () => {
      expect(Math.abs(result.pooledLength - expected["Pooled Length"])).toBeLessThan(EPSILON);
    });

    it("pooled purchase", () => {
      expect(Math.abs(result.pooledPurchase - expected["Pooled Purchase"])).toBeLessThan(EPSILON);
    });

    it("base length", () => {
      expect(Math.abs(result.baseLength - expected["Base Length"])).toBeLessThan(EPSILON);
    });

    it("base purchase", () => {
      expect(Math.abs(result.basePurchase - expected["Base Purchase"])).toBeLessThan(EPSILON);
    });

    it("add-on placements per shirt", () => {
      expect(result.addOnPlacementsPerShirt).toBe(expected["Add-On Placements / Shirt"]);
    });

    it("incremental material per shirt", () => {
      expect(
        Math.abs(result.incrementalMaterialPerShirt - expected["Incremental Material / Shirt"])
      ).toBeLessThan(EPSILON);
    });

    it("operator operating cost", () => {
      expect(
        Math.abs(result.operatorOperatingCost - expected["Operator Operating Cost"])
      ).toBeLessThan(EPSILON);
    });

    it("extra operator labor", () => {
      expect(
        Math.abs(result.extraOperatorLabor - expected["Extra Operator Labor"])
      ).toBeLessThan(EPSILON);
    });

    it("designer labor", () => {
      expect(
        Math.abs(result.designerLabor - expected["Designer Labor"])
      ).toBeLessThan(EPSILON);
    });

    it("incremental COGS per shirt", () => {
      expect(
        Math.abs(result.incrementalCogsPerShirt - expected["Incremental COGS / Shirt"])
      ).toBeLessThan(EPSILON);
    });

    it("T1 price", () => {
      expect(
        Math.abs(result.t1Price - expected["T1 Price"])
      ).toBeLessThan(EPSILON);
    });

    it("engine whole dollar", () => {
      expect(result.engineWhole).toBe(expected["Engine Whole"]);
    });
  });
}
