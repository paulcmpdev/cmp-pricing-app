import { describe, it, expect } from "vitest";
import { lookupTier } from "../tier-lookup";
import { getTierScenario, type TierExpected } from "@/lib/fixtures/parity-scenario-types";

const EPSILON = 1e-9;

describe.each([
  "dtf-tier-q1",
  "dtf-tier-q12",
  "dtf-tier-q84",
  "dtf-tier-q500",
])("%s parity", (scenarioId) => {
  const { inputs, expected } = getTierScenario(scenarioId);
  const { quantity } = inputs;

  const tier = lookupTier(quantity);

  it("tier label", () => {
    expect(tier.tier).toBe(expected.tier);
  });

  it("minQty", () => {
    expect(tier.minQty).toBe(expected.minQty);
  });

  it("maxQty", () => {
    expect(tier.maxQty).toBe(expected.maxQty);
  });

  it("activeTotalDtfCogs", () => {
    expect(Math.abs(tier.activeTotalDtfCogs - expected.activeTotalDtfCogs)).toBeLessThan(EPSILON);
  });

  it("T1 price", () => {
    expect(Math.abs(tier.prices.T1 - expected.prices.T1)).toBeLessThan(EPSILON);
  });

  it("T2 price", () => {
    expect(Math.abs(tier.prices.T2 - expected.prices.T2)).toBeLessThan(EPSILON);
  });

  it("T3 price", () => {
    expect(Math.abs(tier.prices.T3 - expected.prices.T3)).toBeLessThan(EPSILON);
  });

  it("T4 price", () => {
    expect(Math.abs(tier.prices.T4 - expected.prices.T4)).toBeLessThan(EPSILON);
  });

  it("pricingBasis", () => {
    expect(tier.pricingBasis).toBe(expected.pricingBasis);
  });

  it("costingQtyWorstCase", () => {
    expect(tier.costingQtyWorstCase).toBe(expected.costingQtyWorstCase);
  });
});
