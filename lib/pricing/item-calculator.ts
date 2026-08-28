import "server-only";
import { d } from "./money";
import { computeDecorationCogs } from "./dtf-cogs";
import { lookupTierFromConfig } from "./tier-lookup";
import contract from "@/lib/fixtures/pricing-contract.json";
import type { ItemPriceInput, ItemPriceOutput } from "./schemas";

const COMMISSION_RATE = d(contract.pricingPolicy.commissionReserveRate);

export type DynamicTier = {
  tier: string;
  minQty: number;
  maxQty: number | null;
  prices: Record<string, number>;
};

/**
 * Calculate item price.
 * When dynamicTiers is provided, uses those for price lookup instead of contract tiers.
 */
export function calculateItemPrice(
  input: ItemPriceInput,
  dynamicTiers?: DynamicTier[]
): ItemPriceOutput {
  const { productCost, quantity, productCostMultiplier, tierPriceLane } = input;
  const tier = lookupTierFromConfig(quantity, dynamicTiers);

  const lanePrice = tier.prices[tierPriceLane];
  if (lanePrice == null) {
    throw new Error(`Lane "${tierPriceLane}" not found in tier "${tier.tier}"`);
  }

  const productSellD = d(productCost).times(productCostMultiplier);
  const decorationSellD = d(lanePrice);
  const salesPriceD = productSellD.plus(decorationSellD);
  const commissionD = salesPriceD.times(COMMISSION_RATE);
  const decoCogsD = d(computeDecorationCogs(quantity));
  const totalProdCogsD = d(productCost).plus(decoCogsD);
  const grossProfitD = salesPriceD.minus(totalProdCogsD);
  const netContribD = grossProfitD.minus(commissionD);
  const grossMarginD = grossProfitD.div(salesPriceD);
  const contribMarginD = netContribD.div(salesPriceD);
  const qtyD = d(quantity);

  return {
    productSell: productSellD.toNumber(),
    decorationSell: decorationSellD.toNumber(),
    salesPrice: salesPriceD.toNumber(),
    commissionReserve: commissionD.toNumber(),
    totalDecorationCogs: decoCogsD.toNumber(),
    totalProductionCogs: totalProdCogsD.toNumber(),
    grossProfitBeforeCommission: grossProfitD.toNumber(),
    netContributionAfterCommission: netContribD.toNumber(),
    combinedGrossMarginBeforeCommission: grossMarginD.toNumber(),
    contributionMarginAfterCommission: contribMarginD.toNumber(),
    salesOrderTotal: salesPriceD.times(qtyD).toNumber(),
    productionCogsOrderTotal: totalProdCogsD.times(qtyD).toNumber(),
    netContributionOrderTotal: netContribD.times(qtyD).toNumber(),
    tierLabel: tier.tier,
  };
}
