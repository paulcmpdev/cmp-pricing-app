import "server-only";
import { d } from "./money";
import { calculatePooledLength, optimizePurchase } from "./dtf-optimizer";
import { lookupTierFromConfig } from "./tier-lookup";
import contract from "@/lib/fixtures/pricing-contract.json";
import type { ItemPriceInput, ItemPriceOutput } from "./schemas";

const COMMISSION_RATE = d(contract.pricingPolicy.commissionReserveRate);
const OPERATING_COST_PER_PLACEMENT = d(
  contract.dtfEngine.productionModes.find((m) => m.key === "average")!
    .operatingCostPerPlacement!
);
const SHARED_PROJECT_LABOR = d(contract.dtfEngine.sharedProjectLaborPerOrder);
const TRANSFER_WIDTH = contract.dtfEngine.capturedTransferSizeIn.width;
const TRANSFER_HEIGHT = contract.dtfEngine.capturedTransferSizeIn.height;
const PRINT_LOCATIONS = 1;

export type DynamicTier = {
  tier: string;
  minQty: number;
  maxQty: number | null;
  prices: Record<string, number>;
};

function computeDecorationCogs(quantity: number): number {
  const totalLength = calculatePooledLength([
    { widthIn: TRANSFER_WIDTH, heightIn: TRANSFER_HEIGHT, totalCount: quantity },
  ]);
  const purchaseCost = optimizePurchase(totalLength);
  const materialPerGarment = d(purchaseCost).div(quantity);
  const operatingCost = OPERATING_COST_PER_PLACEMENT.times(PRINT_LOCATIONS);
  const laborPerGarment = SHARED_PROJECT_LABOR.div(quantity);
  return materialPerGarment.plus(operatingCost).plus(laborPerGarment).toNumber();
}

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
