/**
 * Typed Staff and Manager response shapes for quote services.
 *
 * Staff responses expose only customer-facing inputs/results.
 * Manager responses include internal engine fields, COGS, wages, margins,
 * and session-local override/labor inputs.
 */

// ---------------------------------------------------------------------------
// Item Price
// ---------------------------------------------------------------------------

export interface StaffItemQuoteResponse {
  productSell: number;
  decorationSell: number;
  salesPrice: number;
  salesOrderTotal: number;
  tierLabel: string;
}

export interface ManagerItemQuoteResponse {
  productSell: number;
  decorationSell: number;
  salesPrice: number;
  commissionReserve: number;
  totalDecorationCogs: number;
  totalProductionCogs: number;
  grossProfitBeforeCommission: number;
  netContributionAfterCommission: number;
  combinedGrossMarginBeforeCommission: number;
  contributionMarginAfterCommission: number;
  salesOrderTotal: number;
  productionCogsOrderTotal: number;
  netContributionOrderTotal: number;
  tierLabel: string;
}

// ---------------------------------------------------------------------------
// Flat-Fee
// ---------------------------------------------------------------------------

export interface StaffFlatFeeQuoteResponse {
  service: string;
  effectivePrice: number;
  status: string;
  billableQuantity: number;
  addOnTotal: number;
}

export interface ManagerFlatFeeQuoteResponse {
  service: string;
  engineCogs: number;
  enginePrice: number;
  policyFloor: number;
  effectivePrice: number;
  grossMargin: number;
  status: string;
  billableQuantity: number;
  addOnTotal: number;
  operatorOperatingCost: number;
  extraOperatorLabor: number;
  extraDesignerLabor: number;
}

// ---------------------------------------------------------------------------
// Keys that only appear in manager responses (used for serialization tests)
// ---------------------------------------------------------------------------

export const MANAGER_ONLY_ITEM_KEYS: readonly string[] = [
  "commissionReserve",
  "totalDecorationCogs",
  "totalProductionCogs",
  "grossProfitBeforeCommission",
  "netContributionAfterCommission",
  "combinedGrossMarginBeforeCommission",
  "contributionMarginAfterCommission",
  "productionCogsOrderTotal",
  "netContributionOrderTotal",
] as const;

export const MANAGER_ONLY_FLAT_FEE_KEYS: readonly string[] = [
  "engineCogs",
  "enginePrice",
  "policyFloor",
  "grossMargin",
  "operatorOperatingCost",
  "extraOperatorLabor",
  "extraDesignerLabor",
] as const;
