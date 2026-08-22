import { describe, it, expect } from "vitest";
import { calculateItemPrice } from "../item-calculator";
import { getItemForwardScenario } from "@/lib/fixtures/parity-scenario-types";

const { inputs: scenario, outputs: expected } = getItemForwardScenario();
const EPSILON = 1e-9;

describe("item-forward-current parity", () => {
  const result = calculateItemPrice({
    productCost: scenario.productCost,
    quantity: scenario.quantity,
    productCostMultiplier: scenario.productCostMultiplier,
    tierPriceLane: scenario.tierPriceLane as "T1" | "T2" | "T3" | "T4",
  });

  it("productSell", () => {
    expect(result.productSell).toBeCloseTo(expected.productSell, 10);
  });

  it("decorationSell", () => {
    expect(Math.abs(result.decorationSell - expected.decorationSell)).toBeLessThan(EPSILON);
  });

  it("salesPrice", () => {
    expect(Math.abs(result.salesPrice - expected.salesPrice)).toBeLessThan(EPSILON);
  });

  it("commissionReserve", () => {
    expect(Math.abs(result.commissionReserve - expected.commissionReserve)).toBeLessThan(EPSILON);
  });

  it("totalDecorationCogs", () => {
    expect(Math.abs(result.totalDecorationCogs - expected.totalDecorationCogs)).toBeLessThan(EPSILON);
  });

  it("totalProductionCogs", () => {
    expect(Math.abs(result.totalProductionCogs - expected.totalProductionCogs)).toBeLessThan(EPSILON);
  });

  it("grossProfitBeforeCommission", () => {
    expect(Math.abs(result.grossProfitBeforeCommission - expected.grossProfitBeforeCommission)).toBeLessThan(EPSILON);
  });

  it("netContributionAfterCommission", () => {
    expect(Math.abs(result.netContributionAfterCommission - expected.netContributionAfterCommission)).toBeLessThan(EPSILON);
  });

  it("combinedGrossMarginBeforeCommission", () => {
    expect(Math.abs(result.combinedGrossMarginBeforeCommission - expected.combinedGrossMarginBeforeCommission)).toBeLessThan(EPSILON);
  });

  it("contributionMarginAfterCommission", () => {
    expect(Math.abs(result.contributionMarginAfterCommission - expected.contributionMarginAfterCommission)).toBeLessThan(EPSILON);
  });

  it("salesOrderTotal", () => {
    expect(Math.abs(result.salesOrderTotal - expected.salesOrderTotal)).toBeLessThan(EPSILON);
  });

  it("productionCogsOrderTotal", () => {
    expect(Math.abs(result.productionCogsOrderTotal - expected.productionCogsOrderTotal)).toBeLessThan(EPSILON);
  });

  it("netContributionOrderTotal", () => {
    expect(Math.abs(result.netContributionOrderTotal - expected.netContributionOrderTotal)).toBeLessThan(EPSILON);
  });
});
