/**
 * Production DTF decoration COGS engine.
 *
 * Extracted verbatim from the item calculator so the admin pricing preview
 * and Quote Desk share one engine rather than two lookalike copies. Values
 * are unchanged: `computeDecorationCogs` is byte-for-byte the calculation the
 * item calculator used before the extraction.
 *
 * Server-only: contains internal COGS data.
 */
import "server-only";
import { d, Decimal } from "./money";
import { calculatePooledLength, optimizePurchase } from "./dtf-optimizer";
import contract from "@/lib/fixtures/pricing-contract.json";

const OPERATING_COST_PER_PLACEMENT = d(
  contract.dtfEngine.productionModes.find((m) => m.key === "average")!
    .operatingCostPerPlacement!
);
const SHARED_PROJECT_LABOR = d(contract.dtfEngine.sharedProjectLaborPerOrder);
const TRANSFER_WIDTH = contract.dtfEngine.capturedTransferSizeIn.width;
const TRANSFER_HEIGHT = contract.dtfEngine.capturedTransferSizeIn.height;
const PRINT_LOCATIONS = 1;

export const SHARED_PROJECT_LABOR_PER_ORDER =
  contract.dtfEngine.sharedProjectLaborPerOrder;

/** Highest quantity the app quotes without manager review. */
export const MAX_SUPPORTED_QUANTITY =
  contract.inputConstraints.quantity.maximumWithoutManagerReview;

/**
 * Approved 1-11 policy: "Small orders 1-11 use the captured 12-23 pooled
 * base-decoration proxy while project labor divides by actual quantity."
 * (pricing-contract.json -> dtfEngine.optimizerRules)
 */
export const POOLED_BASE_MIN_QUANTITY = 12;
export const POOLED_BASE_MAX_QUANTITY = 23;

// Sheet optimization is pure and pricey; the same quantities are probed over
// and over across preview requests, so memoize per quantity.
const baseCogsCache = new Map<number, Decimal>();

/**
 * Base decoration COGS per garment at a given order quantity: optimized
 * gang-sheet material plus operating cost. Excludes shared project labor,
 * which is recovered separately at cost.
 */
export function computeBaseDecorationCogs(quantity: number): Decimal {
  const cached = baseCogsCache.get(quantity);
  if (cached) return cached;

  const totalLength = calculatePooledLength([
    { widthIn: TRANSFER_WIDTH, heightIn: TRANSFER_HEIGHT, totalCount: quantity },
  ]);
  const purchaseCost = optimizePurchase(totalLength);
  const materialPerGarment = d(purchaseCost).div(quantity);
  const operatingCost = OPERATING_COST_PER_PLACEMENT.times(PRINT_LOCATIONS);
  const value = materialPerGarment.plus(operatingCost);

  baseCogsCache.set(quantity, value);
  return value;
}

/**
 * Total modeled decoration COGS per garment at a given order quantity,
 * including shared project labor recovered at cost over that quantity.
 */
export function computeDecorationCogs(quantity: number): number {
  const laborPerGarment = SHARED_PROJECT_LABOR.div(quantity);
  return computeBaseDecorationCogs(quantity).plus(laborPerGarment).toNumber();
}
