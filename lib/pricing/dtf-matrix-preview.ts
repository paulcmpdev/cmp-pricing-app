/**
 * Server-only pricing preview for the unified DTF matrix editor.
 *
 * Unlike the tier/lane-hardcoded preview it replaces, every function here
 * takes a full draft `DtfMatrixConfig`: dynamic lane keys, dynamic tier
 * spans, renamed lanes and added lanes all work without a code change.
 *
 * Policy invariants (see lib/fixtures/pricing-contract.json):
 *   - Product Sell = Product Cost x 2.00.
 *   - DTF lane margins load base decoration COGS only; shared project labor
 *     is recovered at cost.
 *   - The 8% commission reserve is an outcome/audit metric. It is never
 *     embedded in the lane margin or the product multiplier, and
 *     post-commission contribution is never used as a price target.
 */
import "server-only";
import { z } from "zod";
import contract from "@/lib/fixtures/pricing-contract.json";
import { d, type DecimalLike } from "./money";
import { marginFromPrice, tierCostKey } from "./dtf-margin-math";
import { resolveTierCostBasis } from "./dtf-tier-cost";
import { MAX_SUPPORTED_QUANTITY } from "./dtf-cogs";
import type {
  DtfLanePreview,
  DtfMatrixPreview,
  DtfQuoteImpact,
  DtfTierCostBasis,
  DtfTierPreview,
  QuoteDelta,
  QuoteTotals,
} from "./dtf-matrix-preview-types";
import {
  DtfLaneSchema,
  DtfTierSchema,
} from "@/lib/server/pricing-config/schemas";

// ── Request schemas ────────────────────────────────────────────────

/**
 * Deliberately looser than `DtfMatrixConfigSchema`: a preview runs against
 * an in-progress draft, which may momentarily have a gap or a capped final
 * tier while the admin is still typing. All the *bounding* constraints
 * (array sizes, string lengths, numeric floors) are kept so request bodies
 * stay small; only the structural business rules are relaxed, and the
 * preview is read-only.
 */
export const DtfMatrixDraftSchema = z
  .object({
    lanes: z.array(DtfLaneSchema).min(1).max(20),
    tiers: z.array(DtfTierSchema).min(1).max(50),
  })
  .strict()
  .superRefine((data, ctx) => {
    const laneKeys = new Set(data.lanes.map((lane) => lane.key));
    for (let i = 0; i < data.tiers.length; i++) {
      for (const key of Object.keys(data.tiers[i].prices)) {
        // Bounds the prices record to at most one entry per declared lane.
        if (!laneKeys.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Tier "${data.tiers[i].tier}" has a price for undeclared lane "${key}"`,
            path: ["tiers", i, "prices"],
          });
        }
      }
    }
  });

export const DtfQuoteInputSchema = z
  .object({
    productCost: z.number().finite().min(0).max(100_000),
    quantity: z.number().int().min(1).max(MAX_SUPPORTED_QUANTITY),
    lane: z.string().min(1).max(20),
  })
  .strict();

export const DtfMatrixPreviewBodySchema = z
  .object({
    draft: DtfMatrixDraftSchema,
    current: DtfMatrixDraftSchema.optional(),
    quote: DtfQuoteInputSchema.optional(),
  })
  .strict();

export type DtfMatrixDraft = z.infer<typeof DtfMatrixDraftSchema>;
export type DtfQuoteInput = z.infer<typeof DtfQuoteInputSchema>;

// ── Shared constants ───────────────────────────────────────────────

const ROUNDING_INCREMENT = contract.pricingPolicy.roundingIncrement;
const PRODUCT_COST_MULTIPLIER = contract.pricingPolicy.productCostMultiplier;
const COMMISSION_RESERVE_RATE = contract.pricingPolicy.commissionReserveRate;

export const CONTRIBUTION_BASIS =
  "Modeled decoration COGS is the draft tier's resolved cost basis. Both sides of the comparison use it, so the delta reflects price changes only. Commission reserve is reported as an outcome and is never embedded in the lane margin.";

function currency(value: DecimalLike): string {
  return d(value).toDecimalPlaces(2).toFixed(2);
}

function decimalString(value: DecimalLike): string {
  return d(value).toDecimalPlaces(10).toString();
}

// ── Matrix preview ─────────────────────────────────────────────────

export type {
  DtfLanePreview,
  DtfMatrixPreview,
  DtfQuoteImpact,
  DtfTierPreview,
  QuoteDelta,
  QuoteTotals,
};

/**
 * Price -> margin for every active lane of every tier in a draft config.
 * Inactive lanes are omitted: they carry no price for this matrix.
 */
export function calculateMatrixPreview(config: DtfMatrixDraft): DtfMatrixPreview {
  const activeLanes = config.lanes.filter((lane) => lane.active);
  const costBases: Record<string, DtfTierCostBasis> = {};

  const tiers = config.tiers.map((tier) => {
    const costKey = tierCostKey(tier.minQty, tier.maxQty);
    const costBasis =
      costBases[costKey] ??
      resolveTierCostBasis({ minQty: tier.minQty, maxQty: tier.maxQty });
    costBases[costKey] = costBasis;

    const lanes: Record<string, DtfLanePreview> = {};
    for (const lane of activeLanes) {
      const price = tier.prices[lane.key];
      if (price == null) {
        lanes[lane.key] = {
          price: "",
          margin: null,
          marginPercent: null,
          belowCost: false,
          error: `Tier "${tier.tier}" has no price for lane "${lane.key}".`,
        };
        continue;
      }

      const derived = marginFromPrice(costBasis, price);
      lanes[lane.key] = derived.ok
        ? {
            price: currency(price),
            margin: derived.margin,
            marginPercent: derived.marginPercent,
            belowCost: derived.belowCost,
            error: null,
          }
        : {
            price: currency(price),
            margin: null,
            marginPercent: null,
            belowCost: true,
            error: derived.message,
          };
    }

    return {
      tier: tier.tier,
      minQty: tier.minQty,
      maxQty: tier.maxQty,
      costKey,
      costBasis,
      lanes,
    };
  });

  return {
    schemaVersion: contract.schemaVersion,
    source: "lib/fixtures/pricing-contract.json",
    pricingPolicy: {
      productCostMultiplier: PRODUCT_COST_MULTIPLIER,
      commissionReserveRate: COMMISSION_RESERVE_RATE,
      roundingIncrement: currency(ROUNDING_INCREMENT),
    },
    dtfContext: {
      activeProductionMode: contract.dtfEngine.activeProductionMode,
      pricingMode: contract.dtfEngine.pricingMode,
      sharedProjectLaborPerOrder: currency(
        contract.dtfEngine.sharedProjectLaborPerOrder
      ),
      capturedTransferSizeIn: contract.dtfEngine.capturedTransferSizeIn,
      sheetWidthIn: contract.dtfEngine.sheetWidthIn,
      spacingIn: contract.dtfEngine.spacingIn,
      maxSupportedQuantity: MAX_SUPPORTED_QUANTITY,
    },
    costBases,
    tiers,
  };
}

// ── Quote impact ───────────────────────────────────────────────────

function findTierForQuantity(config: DtfMatrixDraft, quantity: number) {
  return config.tiers.find(
    (tier) =>
      quantity >= tier.minQty &&
      (tier.maxQty === null || quantity <= tier.maxQty)
  );
}

function quoteTotals(
  tierLabel: string,
  productCost: number,
  quantity: number,
  decorationSell: DecimalLike,
  modeledDecorationCogs: DecimalLike
): QuoteTotals {
  const productSell = d(productCost).times(PRODUCT_COST_MULTIPLIER);
  const decoration = d(decorationSell);
  const unitPrice = productSell.plus(decoration);
  const orderTotal = unitPrice.times(quantity);
  const commissionReserve = unitPrice.times(COMMISSION_RESERVE_RATE);
  const totalProductionCogs = d(productCost).plus(modeledDecorationCogs);
  const grossProfitBeforeCommission = unitPrice.minus(totalProductionCogs);
  const netContributionAfterCommission =
    grossProfitBeforeCommission.minus(commissionReserve);
  const contributionMarginAfterCommission = unitPrice.eq(0)
    ? d(0)
    : netContributionAfterCommission.div(unitPrice);

  return {
    tier: tierLabel,
    productSell: currency(productSell),
    decorationSell: currency(decoration),
    unitPrice: currency(unitPrice),
    orderTotal: currency(orderTotal),
    commissionReserve: currency(commissionReserve),
    modeledDecorationCogs: currency(modeledDecorationCogs),
    totalProductionCogs: currency(totalProductionCogs),
    grossProfitBeforeCommission: currency(grossProfitBeforeCommission),
    netContributionAfterCommission: currency(netContributionAfterCommission),
    contributionMarginAfterCommission: decimalString(
      contributionMarginAfterCommission
    ),
    netContributionOrderTotal: currency(
      netContributionAfterCommission.times(quantity)
    ),
  };
}

function quoteDelta(current: QuoteTotals, draft: QuoteTotals): QuoteDelta {
  const orderDelta = d(draft.orderTotal).minus(current.orderTotal);
  const percentDelta = d(current.orderTotal).eq(0)
    ? d(0)
    : orderDelta.div(current.orderTotal);

  return {
    productSell: currency(d(draft.productSell).minus(current.productSell)),
    decorationSell: currency(
      d(draft.decorationSell).minus(current.decorationSell)
    ),
    unitPrice: currency(d(draft.unitPrice).minus(current.unitPrice)),
    orderTotal: currency(orderDelta),
    orderPercent: decimalString(percentDelta),
    commissionReserve: currency(
      d(draft.commissionReserve).minus(current.commissionReserve)
    ),
    grossProfitBeforeCommission: currency(
      d(draft.grossProfitBeforeCommission).minus(
        current.grossProfitBeforeCommission
      )
    ),
    netContributionAfterCommission: currency(
      d(draft.netContributionAfterCommission).minus(
        current.netContributionAfterCommission
      )
    ),
    contributionMarginAfterCommission: decimalString(
      d(draft.contributionMarginAfterCommission).minus(
        current.contributionMarginAfterCommission
      )
    ),
    netContributionOrderTotal: currency(
      d(draft.netContributionOrderTotal).minus(current.netContributionOrderTotal)
    ),
  };
}

/**
 * Compare the saved configuration against the unsaved draft for one quote.
 *
 * The tier is selected from each config independently by quantity, and the
 * price is the draft tier/lane's own direct price — so the comparison reacts
 * to a price edit and to a DTF GM% edit identically, because a GM% edit is
 * stored as the resulting direct price.
 */
export function calculateQuoteImpact(input: {
  draft: DtfMatrixDraft;
  current?: DtfMatrixDraft;
  quote: DtfQuoteInput;
}): DtfQuoteImpact {
  const { draft, current, quote } = input;

  const draftTier = findTierForQuantity(draft, quote.quantity);
  if (!draftTier) {
    return {
      available: false,
      reason: "no_draft_tier",
      message: `No draft tier covers quantity ${quote.quantity.toLocaleString()}.`,
    };
  }

  const draftPrice = draftTier.prices[quote.lane];
  if (draftPrice == null) {
    return {
      available: false,
      reason: "no_draft_price",
      message: `Draft tier "${draftTier.tier}" has no price for lane "${quote.lane}".`,
    };
  }

  const costBasis = resolveTierCostBasis({
    minQty: draftTier.minQty,
    maxQty: draftTier.maxQty,
  });
  const modeledDecorationCogs = costBasis.totalDtfCogs;

  const draftTotals = quoteTotals(
    draftTier.tier,
    quote.productCost,
    quote.quantity,
    draftPrice,
    modeledDecorationCogs
  );

  const currentTier = current
    ? findTierForQuantity(current, quote.quantity)
    : undefined;
  const currentPrice = currentTier?.prices[quote.lane];

  if (!current) {
    return {
      available: true,
      quantity: quote.quantity,
      productCost: currency(quote.productCost),
      lane: quote.lane,
      contributionBasis: CONTRIBUTION_BASIS,
      costBasis,
      draft: draftTotals,
      current: null,
      currentUnavailableReason: "No saved configuration to compare against.",
      delta: null,
    };
  }

  if (!currentTier) {
    return {
      available: true,
      quantity: quote.quantity,
      productCost: currency(quote.productCost),
      lane: quote.lane,
      contributionBasis: CONTRIBUTION_BASIS,
      costBasis,
      draft: draftTotals,
      current: null,
      currentUnavailableReason: `The saved configuration has no tier covering quantity ${quote.quantity.toLocaleString()}.`,
      delta: null,
    };
  }

  if (currentPrice == null) {
    return {
      available: true,
      quantity: quote.quantity,
      productCost: currency(quote.productCost),
      lane: quote.lane,
      contributionBasis: CONTRIBUTION_BASIS,
      costBasis,
      draft: draftTotals,
      current: null,
      currentUnavailableReason: `Lane "${quote.lane}" is new — the saved configuration has no price to compare against.`,
      delta: null,
    };
  }

  const currentTotals = quoteTotals(
    currentTier.tier,
    quote.productCost,
    quote.quantity,
    currentPrice,
    modeledDecorationCogs
  );

  return {
    available: true,
    quantity: quote.quantity,
    productCost: currency(quote.productCost),
    lane: quote.lane,
    contributionBasis: CONTRIBUTION_BASIS,
    costBasis,
    draft: draftTotals,
    current: currentTotals,
    currentUnavailableReason: null,
    delta: quoteDelta(currentTotals, draftTotals),
  };
}
