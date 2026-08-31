/**
 * Resolves the cost basis (base DTF COGS + at-cost labor recovery) for an
 * arbitrary quantity tier in the DTF pricing matrix.
 *
 * Two sources, in priority order:
 *
 * 1. `contract` — the tier's span exactly matches a captured tier in
 *    pricing-contract.json. The captured `activeTotalDtfCogs` is used
 *    verbatim, so every baseline row keeps bit-for-bit price and preview
 *    parity with the verified workbook.
 *
 * 2. `engine` — an edited or newly added span with no captured equivalent.
 *    The basis is produced by the SAME production DTF COGS engine Quote Desk
 *    uses (`lib/pricing/dtf-cogs.ts`), taking the exact worst-case (highest)
 *    per-garment base COGS across every quantity in the tier's supported span.
 *    Every quantity is evaluated — there is no sampling. Per-garment sheet cost
 *    sawtooths, so a sampled probe can step straight over a spike (quantity 327
 *    inside the 250-5000 span is the canonical miss) and understate the cost a
 *    tier has to cover. Shared project labor is recovered over `minQty`,
 *    matching the captured contract tiers (worst case within the span) and the
 *    approved "labor at cost" policy.
 *
 * The approved 1-11 rule is preserved: spans that start below quantity 12
 * inherit the captured 12-23 tier's pooled base-decoration basis verbatim,
 * while project labor still divides by the tier's actual minimum quantity.
 *
 * No new business pricing policy is invented here.
 */
import "server-only";
import contract from "@/lib/fixtures/pricing-contract.json";
import { d, Decimal } from "./money";
import {
  computeBaseDecorationCogs,
  MAX_SUPPORTED_QUANTITY,
  POOLED_BASE_MAX_QUANTITY,
  POOLED_BASE_MIN_QUANTITY,
  SHARED_PROJECT_LABOR_PER_ORDER,
} from "./dtf-cogs";
import { tierCostKey } from "./dtf-margin-math";
import type {
  DtfTierCostBasis,
  DtfTierCostSource,
} from "./dtf-matrix-preview-types";

export type { DtfTierCostBasis, DtfTierCostSource };

const CONTRACT_TIERS = contract.dtfEngine.tierPriceMatrix;
const SHARED_PROJECT_LABOR = d(SHARED_PROJECT_LABOR_PER_ORDER);

/**
 * Decimal places used to serialise a basis for JSON transport.
 *
 * 12 rather than 10 on purpose: `baseDtfCogs`, `laborRecovery` and
 * `totalDtfCogs` are rounded independently, so the precision has to be fine
 * enough that `base + labor` still reconstructs `total` well inside the
 * tolerance any consumer (or audit test) would reasonably apply. At 10dp the
 * two roundings can compound to 1e-10, which is the same order as the
 * "labor was never margin-loaded" check itself; at 12dp the compounded error
 * is 1e-12 — three orders of magnitude below the smallest meaningful money
 * difference, and still far short of double-precision noise.
 */
const TRANSPORT_DECIMAL_PLACES = 12;

/**
 * The captured 12-23 tier is the pooled base-decoration proxy that the
 * approved 1-11 policy points at, so it is resolved once here and reused
 * verbatim. Re-deriving it from the engine is deliberately NOT done: the
 * captured workbook value is the authority for this span, and a small-order
 * tier that priced off a re-derived number would silently disagree with the
 * captured 1-11 rows it is supposed to inherit from.
 */
const POOLED_BASE_TIER = CONTRACT_TIERS.find(
  (candidate) =>
    candidate.minQty === POOLED_BASE_MIN_QUANTITY &&
    candidate.maxQty === POOLED_BASE_MAX_QUANTITY
);

if (!POOLED_BASE_TIER) {
  throw new Error(
    `pricing-contract.json is missing the captured ${POOLED_BASE_MIN_QUANTITY}-${POOLED_BASE_MAX_QUANTITY} tier that the approved 1-${POOLED_BASE_MIN_QUANTITY - 1} pooled-base policy depends on.`
  );
}

/** Base decoration COGS per garment for the captured 12-23 pooled proxy. */
const POOLED_BASE_DECORATION_COGS = d(POOLED_BASE_TIER.activeTotalDtfCogs).minus(
  SHARED_PROJECT_LABOR.div(POOLED_BASE_TIER.minQty)
);
const POOLED_BASE_COSTING_QTY = POOLED_BASE_TIER.costingQtyWorstCase;

export type TierSpan = { minQty: number; maxQty: number | null };

function decimalString(value: Decimal): string {
  return value.toDecimalPlaces(TRANSPORT_DECIMAL_PLACES).toString();
}

/**
 * Assemble a basis from a full-precision base and labor. Both are derived
 * from unrounded inputs and only rounded here, so no intermediate rounding
 * accumulates into the numbers the admin sees.
 */
function makeBasis(fields: {
  base: Decimal;
  labor: Decimal;
  costingQty: number;
  basis: string;
  source: DtfTierCostSource;
}): DtfTierCostBasis {
  return {
    baseDtfCogs: decimalString(fields.base),
    laborRecovery: decimalString(fields.labor),
    totalDtfCogs: decimalString(fields.base.plus(fields.labor)),
    costingQty: fields.costingQty,
    basis: fields.basis,
    source: fields.source,
  };
}

function effectiveMax(maxQty: number | null): number {
  return maxQty === null ? MAX_SUPPORTED_QUANTITY : maxQty;
}

function findContractTier(span: TierSpan) {
  return CONTRACT_TIERS.find(
    (candidate) =>
      candidate.minQty === span.minQty &&
      effectiveMax(candidate.maxQty) === effectiveMax(span.maxQty)
  );
}

const engineBasisCache = new Map<string, DtfTierCostBasis>();

function resolveEngineBasis(span: TierSpan): DtfTierCostBasis {
  const minQty = Math.max(1, Math.floor(span.minQty));
  const cacheKey = tierCostKey(minQty, span.maxQty);
  const cached = engineBasisCache.get(cacheKey);
  if (cached) return cached;

  const startsBelowPooledBase = minQty < POOLED_BASE_MIN_QUANTITY;
  const spanMax = Math.max(
    minQty,
    Math.min(effectiveMax(span.maxQty), MAX_SUPPORTED_QUANTITY)
  );

  let worst: Decimal;
  let costingQty: number;
  let usedPooledProxy = false;

  if (startsBelowPooledBase) {
    // Approved 1-11 policy: inherit the captured 12-23 tier's pooled
    // base-decoration basis exactly, so a custom small-order tier costs what
    // the captured 1-11 rows cost. Labor still divides by the actual minimum
    // quantity below, and is added at cost.
    worst = POOLED_BASE_DECORATION_COGS;
    costingQty = POOLED_BASE_COSTING_QTY;
    usedPooledProxy = true;
  } else {
    worst = computeBaseDecorationCogs(minQty);
    costingQty = minQty;
  }

  // Scan the part of the span the proxy does not speak for, one quantity at a
  // time. For a span that starts at 12 or above that is the whole span; for a
  // small-order span that also reaches past 23, it is the tail, which must
  // still cover its own worst case rather than ride the proxy up there.
  //
  // The scan is exhaustive because it is affordable: `computeBaseDecorationCogs`
  // memoizes per quantity, so the widest span this app can express (250-5000)
  // costs ~82ms cold and ~4ms once the cache is warm — cheap enough that there
  // is no reason to trade exactness for sampling.
  const scanLo = startsBelowPooledBase ? POOLED_BASE_MAX_QUANTITY + 1 : minQty;
  for (let q = scanLo; q <= spanMax; q++) {
    const candidate = computeBaseDecorationCogs(q);
    // `gt`, not `gte`: ties keep the lowest quantity, so the reported costing
    // quantity is the first one that reaches the worst case.
    if (candidate.gt(worst)) {
      worst = candidate;
      costingQty = q;
      usedPooledProxy = false;
    }
  }

  const laborRecovery = SHARED_PROJECT_LABOR.div(minQty);
  const basis = usedPooledProxy
    ? // Same wording the captured 1-11 tiers use, because it is the same basis.
      `${POOLED_BASE_MIN_QUANTITY}-${POOLED_BASE_MAX_QUANTITY} pooled base-decoration proxy + project labor / ${minQty} at cost`
    : `Worst-case pooled base decoration across qty ${scanLo}-${spanMax} (qty ${costingQty}) + project labor / ${minQty} at cost`;

  const resolved = makeBasis({
    base: worst,
    labor: laborRecovery,
    costingQty,
    basis,
    source: "engine",
  });

  engineBasisCache.set(cacheKey, resolved);
  return resolved;
}

/**
 * Resolve the cost basis for a tier span. Captured contract spans keep exact
 * baseline parity; every other span is costed with the production engine.
 */
export function resolveTierCostBasis(span: TierSpan): DtfTierCostBasis {
  const contractTier = findContractTier(span);

  if (contractTier) {
    const laborRecovery = SHARED_PROJECT_LABOR.div(contractTier.minQty);
    const total = d(contractTier.activeTotalDtfCogs);
    return makeBasis({
      base: total.minus(laborRecovery),
      labor: laborRecovery,
      costingQty: contractTier.costingQtyWorstCase,
      basis: contractTier.pricingBasis,
      source: "contract",
    });
  }

  return resolveEngineBasis(span);
}
