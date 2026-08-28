/**
 * Response shapes for the admin DTF matrix preview API.
 *
 * Deliberately split out of `dtf-matrix-preview.ts` so the client editor can
 * type the response without importing a `server-only` module (which would
 * pull the internal COGS fixture toward the browser bundle). This file
 * contains type declarations only — it emits no runtime code.
 *
 * The server module imports these same types, so the wire contract has one
 * definition rather than a client copy that can silently drift.
 */

/**
 * `contract` — the tier span exactly matches a captured tier in
 * pricing-contract.json, so the captured COGS is used verbatim and the row
 * keeps bit-for-bit baseline parity.
 * `engine` — an edited or added span, costed with the production DTF COGS
 * engine that Quote Desk uses.
 */
export type DtfTierCostSource = "contract" | "engine";

export type DtfTierCostBasis = {
  /** Margin-loaded portion: optimized material + operating cost per garment. */
  baseDtfCogs: string;
  /** Shared project labor per garment, recovered at cost (never margin-loaded). */
  laborRecovery: string;
  totalDtfCogs: string;
  /** Quantity whose base COGS was used. */
  costingQty: number;
  /** Human-readable explanation, surfaced in the admin UI. */
  basis: string;
  source: DtfTierCostSource;
};

export type DtfLanePreview = {
  price: string;
  /** Fractional DTF gross margin implied by `price`, or null when undefined. */
  margin: string | null;
  marginPercent: string | null;
  belowCost: boolean;
  error: string | null;
};

export type DtfTierPreview = {
  tier: string;
  minQty: number;
  maxQty: number | null;
  costKey: string;
  costBasis: DtfTierCostBasis;
  lanes: Record<string, DtfLanePreview>;
};

export type DtfMatrixPreview = {
  schemaVersion: string;
  source: string;
  pricingPolicy: {
    productCostMultiplier: number;
    commissionReserveRate: number;
    roundingIncrement: string;
  };
  dtfContext: {
    activeProductionMode: string;
    pricingMode: string;
    sharedProjectLaborPerOrder: string;
    capturedTransferSizeIn: { width: number; height: number };
    sheetWidthIn: number;
    spacingIn: number;
    maxSupportedQuantity: number;
  };
  /** Cost bases keyed by `tierCostKey(minQty, maxQty)`, safe to cache client-side. */
  costBases: Record<string, DtfTierCostBasis>;
  tiers: DtfTierPreview[];
};

export type QuoteTotals = {
  tier: string;
  productSell: string;
  decorationSell: string;
  unitPrice: string;
  orderTotal: string;
  commissionReserve: string;
  modeledDecorationCogs: string;
  totalProductionCogs: string;
  grossProfitBeforeCommission: string;
  netContributionAfterCommission: string;
  contributionMarginAfterCommission: string;
  netContributionOrderTotal: string;
};

export type QuoteDelta = {
  productSell: string;
  decorationSell: string;
  unitPrice: string;
  orderTotal: string;
  orderPercent: string;
  commissionReserve: string;
  grossProfitBeforeCommission: string;
  netContributionAfterCommission: string;
  contributionMarginAfterCommission: string;
  netContributionOrderTotal: string;
};

export type DtfQuoteImpact =
  | {
      available: false;
      reason: "no_draft_tier" | "no_draft_price";
      message: string;
    }
  | {
      available: true;
      quantity: number;
      productCost: string;
      lane: string;
      contributionBasis: string;
      costBasis: DtfTierCostBasis;
      draft: QuoteTotals;
      /** Null when the saved config has no comparable price (e.g. a new lane). */
      current: QuoteTotals | null;
      currentUnavailableReason: string | null;
      delta: QuoteDelta | null;
    };

/** Full body returned by `POST /api/admin/pricing/preview`. */
export type DtfPreviewResponse = {
  preview: DtfMatrixPreview;
  quote?: DtfQuoteImpact;
};
