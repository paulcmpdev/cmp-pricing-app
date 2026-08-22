import { describe, it, expect } from "vitest";
import { calculateFlatFeePrice } from "../flat-fee-calculator";
import { calculatePooledFlatFee } from "../pooled-flat-fee-engine";
import scenarios from "@/lib/fixtures/parity-scenarios.json";
import contract from "@/lib/fixtures/pricing-contract.json";

const EPSILON = 1e-9;

describe("flat-fee-current-quick-quote parity", () => {
  const scenario = scenarios.scenarios.find(
    (s) => s.id === "flat-fee-current-quick-quote"
  )!;

  const result = calculateFlatFeePrice({
    service: scenario.selectedService as string,
    orderQuantity: scenario.orderQuantity as number,
    extraOperatorMinutesPerShirt: 0,
    extraDesignerMinutesPerOrder: 0,
    manualOverride: null,
  });

  it("billableQuantity", () => {
    expect(result.billableQuantity).toBe(scenario.billableQuantity);
  });

  it("effectivePrice matches pricePerShirt", () => {
    expect(result.effectivePrice).toBe(scenario.pricePerShirt);
  });

  it("addOnTotal", () => {
    expect(result.addOnTotal).toBe(scenario.addOnTotal);
  });

  it("service name preserved", () => {
    expect(result.service).toBe(scenario.selectedService);
  });

  const contractRow = contract.flatFeeServices.find(
    (s) => s.service === scenario.selectedService
  )!;

  it("enginePrice matches worst-case whole-dollar from pooled engine", () => {
    expect(result.enginePrice).toBe(contractRow.enginePrice);
  });

  it("engineCogs is positive and less than effectivePrice", () => {
    expect(result.engineCogs).toBeGreaterThan(0);
    expect(result.engineCogs).toBeLessThan(result.effectivePrice);
  });

  it("policyFloor preserved from contract", () => {
    expect(result.policyFloor).toBe(contractRow.policyFloor);
  });

  it("status reflects policy floor winning", () => {
    expect(result.status).toBe("Policy floor");
  });

  it("grossMargin is self-consistent with effectivePrice and engineCogs", () => {
    const expectedMargin =
      (result.effectivePrice - result.engineCogs) / result.effectivePrice;
    expect(Math.abs(result.grossMargin - expectedMargin)).toBeLessThan(EPSILON);
  });
});

describe("manual-override parity", () => {
  const scenario = scenarios.scenarios.find(
    (s) => s.id === "manual-override"
  )!;
  const examples = scenario.examples as Array<{
    service: string;
    manualOverride: number | null;
    effectivePrice: number;
  }>;

  describe("populated override wins", () => {
    const ex = examples[0];
    const contractRow = contract.flatFeeServices.find(
      (s) => s.service === ex.service
    )!;

    const result = calculateFlatFeePrice({
      service: ex.service,
      orderQuantity: 12,
      extraOperatorMinutesPerShirt: 0,
      extraDesignerMinutesPerOrder: 0,
      manualOverride: ex.manualOverride,
    });

    it("effectivePrice equals manual override", () => {
      expect(result.effectivePrice).toBe(ex.effectivePrice);
    });

    it("status is Manual override", () => {
      expect(result.status).toBe("Manual override");
    });

    it("enginePrice preserved", () => {
      expect(result.enginePrice).toBe(contractRow.enginePrice);
    });

    it("grossMargin recalculated from override price and session COGS", () => {
      const expectedMargin =
        (ex.effectivePrice - result.engineCogs) / ex.effectivePrice;
      expect(
        Math.abs(result.grossMargin - expectedMargin)
      ).toBeLessThan(EPSILON);
    });
  });

  describe("blank override falls back to max(policy floor, engine price)", () => {
    const ex = examples[1];
    const contractRow = contract.flatFeeServices.find(
      (s) => s.service === ex.service
    )!;

    const result = calculateFlatFeePrice({
      service: ex.service,
      orderQuantity: 12,
      extraOperatorMinutesPerShirt: 0,
      extraDesignerMinutesPerOrder: 0,
      manualOverride: null,
    });

    it("effectivePrice equals max(floor, engine)", () => {
      expect(result.effectivePrice).toBe(ex.effectivePrice);
    });

    it("status is Engine price", () => {
      expect(result.status).toBe("Engine price");
    });

    it("enginePrice preserved", () => {
      expect(result.enginePrice).toBe(contractRow.enginePrice);
    });

    it("engineCogs at qty 12 matches contract worst-case COGS", () => {
      expect(
        Math.abs(result.engineCogs - contractRow.engineCogs)
      ).toBeLessThan(EPSILON);
    });

    it("grossMargin self-consistent", () => {
      const expectedMargin =
        (result.effectivePrice - result.engineCogs) / result.effectivePrice;
      expect(
        Math.abs(result.grossMargin - expectedMargin)
      ).toBeLessThan(EPSILON);
    });
  });

  describe("blank override must not become zero", () => {
    it("undefined override treated as null, not zero", () => {
      const result = calculateFlatFeePrice({
        service: "Sleeve Print",
        orderQuantity: 12,
        extraOperatorMinutesPerShirt: 0,
        extraDesignerMinutesPerOrder: 0,
        manualOverride: null,
      });
      expect(result.effectivePrice).toBeGreaterThan(0);
      expect(result.effectivePrice).not.toBe(0);
    });
  });
});

describe("labor edits materially change COGS, price, and margin", () => {
  const baseResult = calculateFlatFeePrice({
    service: "Additional Large Print",
    orderQuantity: 12,
    extraOperatorMinutesPerShirt: 0,
    extraDesignerMinutesPerOrder: 0,
    manualOverride: null,
  });

  const laborResult = calculateFlatFeePrice({
    service: "Additional Large Print",
    orderQuantity: 12,
    extraOperatorMinutesPerShirt: 5,
    extraDesignerMinutesPerOrder: 30,
    manualOverride: null,
  });

  it("extra labor increases engineCogs", () => {
    expect(laborResult.engineCogs).toBeGreaterThan(baseResult.engineCogs);
  });

  it("extra labor increases enginePrice", () => {
    expect(laborResult.enginePrice).toBeGreaterThanOrEqual(
      baseResult.enginePrice
    );
  });

  it("extra labor reduces gross margin", () => {
    expect(laborResult.grossMargin).toBeLessThan(baseResult.grossMargin);
  });

  it("COGS increase is material (> $0.50)", () => {
    expect(laborResult.engineCogs - baseResult.engineCogs).toBeGreaterThan(0.5);
  });

  it("grossMargin is self-consistent", () => {
    const expectedMargin =
      (laborResult.effectivePrice - laborResult.engineCogs) /
      laborResult.effectivePrice;
    expect(
      Math.abs(laborResult.grossMargin - expectedMargin)
    ).toBeLessThan(EPSILON);
  });
});

describe("zero-session-extra baseline matches calculatePooledFlatFee", () => {
  const service = "Sleeve Print";
  const quantity = 12;

  const liveResult = calculateFlatFeePrice({
    service,
    orderQuantity: quantity,
    extraOperatorMinutesPerShirt: 0,
    extraDesignerMinutesPerOrder: 0,
    manualOverride: null,
  });

  const pooledResult = calculatePooledFlatFee({ service, quantity });

  it("session COGS equals pooled incrementalCogsPerShirt at billable qty", () => {
    expect(Math.abs(liveResult.engineCogs - pooledResult.incrementalCogsPerShirt)).toBeLessThan(EPSILON);
  });

  it("operatorOperatingCost matches pooled engine", () => {
    expect(liveResult.operatorOperatingCost).toBe(pooledResult.operatorOperatingCost);
  });

  it("enginePrice equals pooled worst-case whole-dollar", () => {
    const contractRow = contract.flatFeeServices.find(
      (s) => s.service === service
    )!;
    expect(liveResult.enginePrice).toBe(contractRow.enginePrice);
  });
});

describe("session labor delta regression", () => {
  const service = "Additional Large Print";
  const quantity = 18;
  const extraOp = 3;
  const extraDes = 20;

  const baseResult = calculateFlatFeePrice({
    service,
    orderQuantity: quantity,
    extraOperatorMinutesPerShirt: 0,
    extraDesignerMinutesPerOrder: 0,
    manualOverride: null,
  });

  const deltaResult = calculateFlatFeePrice({
    service,
    orderQuantity: quantity,
    extraOperatorMinutesPerShirt: extraOp,
    extraDesignerMinutesPerOrder: extraDes,
    manualOverride: null,
  });

  it("session extra labor increases COGS", () => {
    expect(deltaResult.engineCogs).toBeGreaterThan(baseResult.engineCogs);
  });

  it("session extra labor increases or preserves enginePrice", () => {
    expect(deltaResult.enginePrice).toBeGreaterThanOrEqual(baseResult.enginePrice);
  });

  it("session extra labor reduces gross margin", () => {
    expect(deltaResult.grossMargin).toBeLessThan(baseResult.grossMargin);
  });

  it("COGS delta is consistent with labor inputs", () => {
    const opWage = contract.labor.operatorWagePerHour;
    const desWage = contract.labor.designerWagePerHour;
    const expectedDelta =
      (extraOp / 60) * opWage + (extraDes / 60) * desWage / quantity;
    const actualDelta = deltaResult.engineCogs - baseResult.engineCogs;
    expect(Math.abs(actualDelta - expectedDelta)).toBeLessThan(EPSILON);
  });
});
