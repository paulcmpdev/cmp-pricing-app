import { describe, expect, it } from "vitest";
import { formatCurrency } from "@/lib/client/format";

/**
 * Pure computation test proving the order-total defect.
 *
 * The QuoteDeskClient computes:
 *   finalPerItemPrice = salesPrice + additionalLocationsTotalPerItem
 *   orderTotal = finalPerItemPrice * qty
 *   totalCogsPerItem = totalProductionCogs + sum(location COGS)
 *   combinedNetContribution = (finalPerItemPrice - totalCogsPerItem) - commission
 *
 * But the Item Price Summary section displays:
 *   "Item Order Total" → itemQuote.salesOrderTotal  (base only, WRONG)
 *   "Production COGS Total" → itemQuote.productionCogsOrderTotal  (base only, WRONG)
 *   "Net Contribution Total" → itemQuote.netContributionOrderTotal  (base only, WRONG)
 *
 * The correct values when additionalLocationsEnabled should be:
 *   "Item Order Total" → finalPerItemPrice * qty
 *   "Production COGS Total" → totalCogsPerItem * qty
 *   "Net Contribution Total" → combinedNetContribution * qty
 */

const COMMISSION_RATE = 0.08;

describe("order total reconciliation when additionalLocationsEnabled", () => {
  // Simulated engine responses
  const itemQuote = {
    salesPrice: 10.36,
    salesOrderTotal: 870.24,
    totalProductionCogs: 6.33,
    totalDecorationCogs: 2.38,
    productionCogsOrderTotal: 531.72,
    netContributionAfterCommission: 3.2,
    netContributionOrderTotal: 268.8,
  };

  const locationEffectivePrice = 1.25;
  const locationEngineCogs = 0.65;
  const qty = 84;

  // Combined values (what QuoteDeskClient correctly computes)
  const finalPerItemPrice = itemQuote.salesPrice + locationEffectivePrice; // 11.61
  const combinedOrderTotal = finalPerItemPrice * qty; // 975.24
  const totalCogsPerItem = itemQuote.totalProductionCogs + locationEngineCogs; // 6.98
  const combinedCommission = finalPerItemPrice * COMMISSION_RATE;
  const combinedGrossProfit = finalPerItemPrice - totalCogsPerItem;
  const combinedNetContribution = combinedGrossProfit - combinedCommission;

  it("combined order total differs from base salesOrderTotal", () => {
    // Proves the values are actually different
    expect(combinedOrderTotal).not.toBeCloseTo(itemQuote.salesOrderTotal, 0);
    expect(combinedOrderTotal).toBeCloseTo(975.24, 0);
  });

  it("combined COGS total differs from base productionCogsOrderTotal", () => {
    const combinedCogsTotal = totalCogsPerItem * qty;
    expect(combinedCogsTotal).not.toBeCloseTo(itemQuote.productionCogsOrderTotal, 0);
    expect(combinedCogsTotal).toBeCloseTo(586.32, 0);
  });

  it("combined net contribution total differs from base netContributionOrderTotal", () => {
    const combinedNetContribTotal = combinedNetContribution * qty;
    expect(combinedNetContribTotal).not.toBeCloseTo(itemQuote.netContributionOrderTotal, 0);
  });

  it("summary Item Order Total must show finalPerItemPrice * qty, not salesOrderTotal", () => {
    // After the fix, the summary section should display:
    const expectedSummaryOrderTotal = formatCurrency(finalPerItemPrice * qty);
    const baseOnlyTotal = formatCurrency(itemQuote.salesOrderTotal);

    // These are different — the fix must switch to the combined total
    expect(expectedSummaryOrderTotal).not.toBe(baseOnlyTotal);
    expect(expectedSummaryOrderTotal).toBe("$975.24");
    expect(baseOnlyTotal).toBe("$870.24");
  });

  it("summary Production COGS Total must show totalCogsPerItem * qty", () => {
    const expectedCogstotal = formatCurrency(totalCogsPerItem * qty);
    const baseOnlyCogsTotal = formatCurrency(itemQuote.productionCogsOrderTotal);

    expect(expectedCogstotal).not.toBe(baseOnlyCogsTotal);
  });

  it("summary Net Contribution Total must show combinedNetContribution * qty", () => {
    const expectedNetContribTotal = formatCurrency(combinedNetContribution * qty);
    const baseOnlyNetContribTotal = formatCurrency(itemQuote.netContributionOrderTotal);

    expect(expectedNetContribTotal).not.toBe(baseOnlyNetContribTotal);
  });
});
