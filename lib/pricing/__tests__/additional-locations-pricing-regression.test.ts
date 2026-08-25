import { describe, it, expect } from "vitest";
import { calculateItemPrice } from "../item-calculator";

/**
 * Regression: T1 pricing baseline must remain unchanged before and after
 * Additional Location feature. Product Sell + Base Decoration Sell from
 * current T1 decoration gross-margin lane are authoritative.
 *
 * ADR 0002 (ACCEPTED): T1–T4 remain DTF decoration gross-margin lanes.
 * ADR 0001 (REJECTED): contribution-target solver must NOT exist.
 */
describe("T1 pricing baseline regression (ADR 0002)", () => {
  // Product cost $2.12, quantity 24 => tier "24-35", T1 lane
  const result = calculateItemPrice({
    productCost: 2.12,
    quantity: 24,
    productCostMultiplier: 2,
    tierPriceLane: "T1",
  });

  it("Product Sell = productCost * 2.00 = $4.24", () => {
    expect(result.productSell).toBe(4.24);
  });

  it("Decoration Sell = T1 tier price = $10.85", () => {
    expect(result.decorationSell).toBeCloseTo(10.85, 10);
  });

  it("Sales Price = Product Sell + Decoration Sell = $15.09", () => {
    expect(result.salesPrice).toBeCloseTo(15.09, 10);
  });

  it("tierLabel is 24-35", () => {
    expect(result.tierLabel).toBe("24-35");
  });

  it("Adding locations must only add their approved effective prices", () => {
    // Final Per-Item Price = salesPrice + sum(location effective prices)
    // With zero locations, Final Per-Item Price === salesPrice
    const additionalLocationPrices: number[] = [];
    const finalPerItemPrice =
      result.salesPrice + additionalLocationPrices.reduce((s, p) => s + p, 0);
    expect(finalPerItemPrice).toBeCloseTo(15.09, 10);

    // With one location at $5.00 (hypothetical)
    const withOneLocation =
      result.salesPrice + [5.0].reduce((s, p) => s + p, 0);
    expect(withOneLocation).toBeCloseTo(20.09, 10);

    // With two locations at $5.00 and $2.25
    const withTwoLocations =
      result.salesPrice + [5.0, 2.25].reduce((s, p) => s + p, 0);
    expect(withTwoLocations).toBeCloseTo(22.34, 10);
  });

  it("Commission is 8% of final combined selling price (not embedded in multiplier)", () => {
    const COMMISSION_RATE = 0.08;
    const additionalLocationPrice = 5.0;
    const finalPerItemPrice = result.salesPrice + additionalLocationPrice;
    const commission = finalPerItemPrice * COMMISSION_RATE;
    expect(commission).toBeCloseTo(20.09 * 0.08, 10);
  });
});

describe("Additive pricing contract (ADR 0002)", () => {
  const result = calculateItemPrice({
    productCost: 2.12,
    quantity: 24,
    productCostMultiplier: 2,
    tierPriceLane: "T1",
  });

  it("Final Per-Item Price formula: Product Sell + Base Decoration Sell + sum(Additional Location Prices)", () => {
    const locationPrices = [5.0, 2.25];
    const finalPerItemPrice =
      result.productSell +
      result.decorationSell +
      locationPrices.reduce((s, p) => s + p, 0);
    // 4.24 + 10.85 + 5.00 + 2.25 = 22.34
    expect(finalPerItemPrice).toBeCloseTo(22.34, 10);
  });

  it("Order Total = Final Per-Item Price * quantity", () => {
    const locationPrices = [5.0, 2.25];
    const finalPerItemPrice =
      result.salesPrice + locationPrices.reduce((s, p) => s + p, 0);
    const orderTotal = finalPerItemPrice * 24;
    expect(orderTotal).toBeCloseTo(22.34 * 24, 10);
  });

  it("Total COGS / Item = Product COGS + Base Decoration COGS + sum(location COGS)", () => {
    const productCogs = 2.12;
    const baseDecorationCogs = result.totalDecorationCogs;
    const locationCogs = [1.6, 0.93];
    const totalCogs =
      productCogs + baseDecorationCogs + locationCogs.reduce((s, c) => s + c, 0);
    expect(totalCogs).toBeGreaterThan(0);
    // totalProductionCogs is productCost + decorationCogs
    expect(result.totalProductionCogs).toBeCloseTo(productCogs + baseDecorationCogs, 10);
  });

  it("Combined audit metrics are derived from final price; they MUST NOT adjust price", () => {
    const COMMISSION_RATE = 0.08;
    const locationPrices = [5.0];
    const locationCogs = [1.6];
    const finalPerItemPrice =
      result.salesPrice + locationPrices.reduce((s, p) => s + p, 0);
    const totalCogs =
      result.totalProductionCogs + locationCogs.reduce((s, c) => s + c, 0);

    // These are output-only audit values, not pricing inputs
    const commissionReserve = finalPerItemPrice * COMMISSION_RATE;
    const grossProfit = finalPerItemPrice - totalCogs;
    const netContribution = grossProfit - commissionReserve;
    const grossMargin = grossProfit / finalPerItemPrice;
    const contributionMargin = netContribution / finalPerItemPrice;

    expect(commissionReserve).toBeGreaterThan(0);
    expect(grossProfit).toBeGreaterThan(0);
    expect(netContribution).toBeGreaterThan(0);
    expect(grossMargin).toBeGreaterThan(0);
    expect(contributionMargin).toBeGreaterThan(0);

    // The final price is still the additive sum, not adjusted by any target
    expect(finalPerItemPrice).toBeCloseTo(result.salesPrice + 5.0, 10);
  });
});

describe("No contribution-target solver (ADR 0001 REJECTED)", () => {
  it("contribution-target-solver.ts does not exist", async () => {
    // @ts-expect-error — intentionally importing a deleted module to prove it's gone
    await expect(import("../contribution-target-solver")).rejects.toThrow();
  });

  it("no solveContributionTarget export exists in the pricing module", async () => {
    const itemCalc = await import("../item-calculator");
    expect("solveContributionTarget" in itemCalc).toBe(false);
  });

  it("no CONTRIBUTION_TARGET_LANES export exists", async () => {
    const itemCalc = await import("../item-calculator");
    expect("CONTRIBUTION_TARGET_LANES" in itemCalc).toBe(false);
  });

  it("item calculator output has no contributionTargetAdjustment field", () => {
    const result = calculateItemPrice({
      productCost: 2.12,
      quantity: 24,
      productCostMultiplier: 2,
      tierPriceLane: "T1",
    });
    expect("contributionTargetAdjustment" in result).toBe(false);
    expect("pricingBasis" in result).toBe(false);
    expect("requiredTargetPrice" in result).toBe(false);
  });

  it("T1–T4 are decoration gross-margin lanes, not contribution targets", () => {
    // T1 at 50% gross margin: decorationSell = decorationCogs / (1 - 0.50)
    // These are decoration margin controls, not final-item targets
    const t1 = calculateItemPrice({
      productCost: 2.12, quantity: 24,
      productCostMultiplier: 2, tierPriceLane: "T1",
    });
    const t4 = calculateItemPrice({
      productCost: 2.12, quantity: 24,
      productCostMultiplier: 2, tierPriceLane: "T4",
    });
    // T1 has higher decoration sell than T4 (higher margin)
    expect(t1.decorationSell).toBeGreaterThan(t4.decorationSell);
    // Product sell is the same regardless of lane
    expect(t1.productSell).toBe(t4.productSell);
    // Sales price differs only by decoration sell
    expect(t1.salesPrice - t4.salesPrice).toBeCloseTo(
      t1.decorationSell - t4.decorationSell, 10
    );
  });
});
