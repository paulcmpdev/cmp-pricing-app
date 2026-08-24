import "server-only";
import { z } from "zod";
import contract from "@/lib/fixtures/pricing-contract.json";
import { d, roundUpToIncrement, type DecimalLike } from "./money";

export const DTF_MARGIN_LANES = ["T1", "T2", "T3", "T4"] as const;
export type DtfMarginLane = (typeof DTF_MARGIN_LANES)[number];

const CURRENT_MARGINS: Record<DtfMarginLane, string> = {
  T1: "0.50",
  T2: "0.45",
  T3: "0.40",
  T4: "0.35",
};

const tierIds = contract.dtfEngine.tierPriceMatrix.map((tier) => tier.tier);
const tierIdSet = new Set(tierIds);
const laneSet = new Set<string>(DTF_MARGIN_LANES);

function currency(value: DecimalLike): string {
  return d(value).toDecimalPlaces(2).toFixed(2);
}

function decimalString(value: DecimalLike): string {
  return d(value).toDecimalPlaces(10).toString();
}

function canonicalMarginPercent(value: number): string {
  return d(value).div(100).toDecimalPlaces(10).toString();
}

const MarginEditSchema = z.object({
  tier: z.string().refine((tier) => tierIdSet.has(tier), "Unknown tier."),
  lane: z.string().refine((lane) => laneSet.has(lane), "Unknown margin lane."),
  marginPercent: z.number().finite().min(0).lt(100),
}).transform((edit) => ({
  tier: edit.tier,
  lane: edit.lane as DtfMarginLane,
  marginPercent: edit.marginPercent,
  margin: canonicalMarginPercent(edit.marginPercent),
}));

const DraftMarginInputBaseSchema = z.object({
  edits: z.array(MarginEditSchema).max(92).default([]),
});

function rejectDuplicateEdits(
  input: { edits: Array<{ tier: string; lane: DtfMarginLane }> },
  ctx: z.RefinementCtx
) {
  const seen = new Set<string>();

  for (const edit of input.edits) {
    const key = `${edit.tier}:${edit.lane}`;
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["edits"],
        message: `Duplicate edit for ${key}.`,
      });
      return;
    }
    seen.add(key);
  }
}

export const DraftMarginInputSchema = DraftMarginInputBaseSchema.superRefine(
  rejectDuplicateEdits
);

export const QuoteImpactInputSchema = z.object({
  productCost: z.number().finite().min(0),
  quantity: z.number().int().min(1).max(5000),
  lane: z.enum(DTF_MARGIN_LANES),
});

export const PreviewPostBodySchema = DraftMarginInputBaseSchema.extend({
  quote: QuoteImpactInputSchema.optional(),
}).strict().superRefine(rejectDuplicateEdits);

export type DraftMarginInput = z.input<typeof DraftMarginInputSchema>;
export type QuoteImpactInput = z.input<typeof QuoteImpactInputSchema>;

export type DtfMarginTrace = {
  baseDtfCogs: string;
  laborRecovery: string;
  targetMargin: string;
  marginLoadedAmount: string;
  raw: string;
  increment: string;
  final: string;
  achievedMargin: string;
};

export type DtfMarginPreview = ReturnType<typeof calculateDtfMarginPreview>;

function findTierForQuantity(quantity: number) {
  const tier = contract.dtfEngine.tierPriceMatrix.find(
    (candidate) => quantity >= candidate.minQty && quantity <= candidate.maxQty
  );
  if (!tier) {
    throw new Error(`No tier found for quantity ${quantity}`);
  }
  return tier;
}

function calculateTrace(tier: (typeof contract.dtfEngine.tierPriceMatrix)[number], margin: string): DtfMarginTrace {
  const laborRecovery = d(contract.dtfEngine.sharedProjectLaborPerOrder).div(tier.minQty);
  const baseDtfCogs = d(tier.activeTotalDtfCogs).minus(laborRecovery);
  const targetMargin = d(margin);
  const oneMinusMargin = d(1).minus(targetMargin);

  if (oneMinusMargin.lte(0)) {
    throw new Error("Target margin must be less than 100%.");
  }

  const marginLoadedAmount = baseDtfCogs.div(oneMinusMargin);
  const raw = marginLoadedAmount.plus(laborRecovery);
  const final = roundUpToIncrement(raw, contract.pricingPolicy.roundingIncrement);

  if (!final.isFinite() || final.lte(0)) {
    throw new Error("Calculated DTF price must be finite and positive.");
  }

  const achievedMargin = final.minus(laborRecovery).minus(baseDtfCogs)
    .div(final.minus(laborRecovery));

  return {
    baseDtfCogs: decimalString(baseDtfCogs),
    laborRecovery: decimalString(laborRecovery),
    targetMargin: targetMargin.toDecimalPlaces(10).toString(),
    marginLoadedAmount: decimalString(marginLoadedAmount),
    raw: decimalString(raw),
    increment: currency(contract.pricingPolicy.roundingIncrement),
    final: currency(final),
    achievedMargin: decimalString(achievedMargin),
  };
}

function calculateTierCogs(tier: (typeof contract.dtfEngine.tierPriceMatrix)[number]) {
  const laborRecovery = d(contract.dtfEngine.sharedProjectLaborPerOrder).div(tier.minQty);
  const baseDtfCogs = d(tier.activeTotalDtfCogs).minus(laborRecovery);

  return {
    baseDtfCogs: decimalString(baseDtfCogs),
    laborRecovery: decimalString(laborRecovery),
  };
}

export function calculateDtfMarginPreview(input: DraftMarginInput) {
  const parsed = DraftMarginInputSchema.parse(input);
  const edits = new Map(parsed.edits.map((edit) => [`${edit.tier}:${edit.lane}`, edit]));

  return {
    schemaVersion: contract.schemaVersion,
    source: "lib/fixtures/pricing-contract.json",
    pricingPolicy: {
      productCostMultiplier: contract.pricingPolicy.productCostMultiplier,
      commissionReserveRate: contract.pricingPolicy.commissionReserveRate,
      roundingIncrement: currency(contract.pricingPolicy.roundingIncrement),
    },
    dtfContext: {
      activeProductionMode: contract.dtfEngine.activeProductionMode,
      pricingMode: contract.dtfEngine.pricingMode,
      sharedProjectLaborPerOrder: currency(contract.dtfEngine.sharedProjectLaborPerOrder),
      capturedTransferSizeIn: contract.dtfEngine.capturedTransferSizeIn,
      sheetWidthIn: contract.dtfEngine.sheetWidthIn,
      spacingIn: contract.dtfEngine.spacingIn,
    },
    tiers: contract.dtfEngine.tierPriceMatrix.map((tier) => {
      const tierCogs = calculateTierCogs(tier);
      const lanes = Object.fromEntries(
        DTF_MARGIN_LANES.map((lane) => {
          const edit = edits.get(`${tier.tier}:${lane}`);
          const current = calculateTrace(tier, CURRENT_MARGINS[lane]);
          const draft = edit ? calculateTrace(tier, edit.margin) : current;

          return [lane, {
            currentMargin: CURRENT_MARGINS[lane],
            draftMargin: edit?.margin ?? CURRENT_MARGINS[lane],
            edited: edit != null,
            current,
            draft,
          }];
        })
      ) as Record<DtfMarginLane, {
        currentMargin: string;
        draftMargin: string;
        edited: boolean;
        current: DtfMarginTrace;
        draft: DtfMarginTrace;
      }>;

      return {
        tier: tier.tier,
        minQty: tier.minQty,
        maxQty: tier.maxQty,
        activeTotalDtfCogs: decimalString(tier.activeTotalDtfCogs),
        ...tierCogs,
        costingQtyWorstCase: tier.costingQtyWorstCase,
        pricingBasis: tier.pricingBasis,
        lanes,
      };
    }),
  };
}

function quoteTotals(
  productCost: number,
  quantity: number,
  decorationSell: string,
  modeledDecorationCogs: DecimalLike
) {
  const productSell = d(productCost).times(contract.pricingPolicy.productCostMultiplier);
  const decoration = d(decorationSell);
  const unitPrice = productSell.plus(decoration);
  const orderTotal = unitPrice.times(quantity);
  const commissionReserve = unitPrice.times(contract.pricingPolicy.commissionReserveRate);
  const totalProductionCogs = d(productCost).plus(modeledDecorationCogs);
  const grossProfitBeforeCommission = unitPrice.minus(totalProductionCogs);
  const netContributionAfterCommission = grossProfitBeforeCommission.minus(commissionReserve);
  const contributionMarginAfterCommission = unitPrice.eq(0)
    ? d(0)
    : netContributionAfterCommission.div(unitPrice);
  const netContributionOrderTotal = netContributionAfterCommission.times(quantity);

  return {
    productSell: currency(productSell),
    decorationSell: currency(decoration),
    unitPrice: currency(unitPrice),
    orderTotal: currency(orderTotal),
    commissionReserve: currency(commissionReserve),
    modeledDecorationCogs: currency(modeledDecorationCogs),
    totalProductionCogs: currency(totalProductionCogs),
    grossProfitBeforeCommission: currency(grossProfitBeforeCommission),
    netContributionAfterCommission: currency(netContributionAfterCommission),
    contributionMarginAfterCommission: decimalString(contributionMarginAfterCommission),
    netContributionOrderTotal: currency(netContributionOrderTotal),
  };
}

export function calculateQuoteImpactPreview(
  input: QuoteImpactInput & DraftMarginInput
) {
  const quote = QuoteImpactInputSchema.parse(input);
  const preview = calculateDtfMarginPreview({ edits: input.edits });
  const activeTier = findTierForQuantity(quote.quantity);
  const draftTier = preview.tiers.find((tier) => tier.tier === activeTier.tier);

  if (!draftTier) {
    throw new Error(`No preview tier found for ${activeTier.tier}`);
  }

  // Internal contribution preview uses the active tier's modeled decoration COGS.
  // This is intentionally separate from the production item calculator.
  const modeledDecorationCogs = d(activeTier.activeTotalDtfCogs);
  const current = quoteTotals(
    quote.productCost,
    quote.quantity,
    currency(activeTier.prices[quote.lane]),
    modeledDecorationCogs
  );
  const draft = quoteTotals(
    quote.productCost,
    quote.quantity,
    draftTier.lanes[quote.lane].draft.final,
    modeledDecorationCogs
  );
  const unitDelta = d(draft.unitPrice).minus(current.unitPrice);
  const orderDelta = d(draft.orderTotal).minus(current.orderTotal);
  const commissionDelta = d(draft.commissionReserve).minus(current.commissionReserve);
  const grossProfitDelta = d(draft.grossProfitBeforeCommission).minus(
    current.grossProfitBeforeCommission
  );
  const netContributionDelta = d(draft.netContributionAfterCommission).minus(
    current.netContributionAfterCommission
  );
  const contributionMarginDelta = d(draft.contributionMarginAfterCommission).minus(
    current.contributionMarginAfterCommission
  );
  const orderNetContributionDelta = d(draft.netContributionOrderTotal).minus(
    current.netContributionOrderTotal
  );
  const percentDelta = d(current.orderTotal).eq(0) ? d(0) : orderDelta.div(current.orderTotal);

  return {
    tier: activeTier.tier,
    lane: quote.lane,
    productCost: currency(quote.productCost),
    quantity: quote.quantity,
    contributionBasis:
      "Internal contribution preview uses active tier COGS as modeled decoration COGS.",
    current,
    draft,
    delta: {
      productSell: currency(d(0)),
      decorationSell: currency(d(draft.decorationSell).minus(current.decorationSell)),
      unitPrice: currency(unitDelta),
      orderTotal: currency(orderDelta),
      orderPercent: decimalString(percentDelta),
      commissionReserve: currency(commissionDelta),
      grossProfitBeforeCommission: currency(grossProfitDelta),
      netContributionAfterCommission: currency(netContributionDelta),
      contributionMarginAfterCommission: decimalString(contributionMarginDelta),
      netContributionOrderTotal: currency(orderNetContributionDelta),
    },
  };
}
