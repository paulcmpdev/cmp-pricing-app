/**
 * Type-safe accessors for parity scenario fixture data.
 * Avoids weakening tsconfig while providing narrowed types for each scenario shape.
 */
import scenariosJson from "./parity-scenarios.json";

type Scenario = (typeof scenariosJson.scenarios)[number];

// ---------------------------------------------------------------------------
// Item-forward-current scenario
// ---------------------------------------------------------------------------
export interface ItemForwardInputs {
  productCost: number;
  quantity: number;
  decorationMethod: string;
  productionMode: string;
  transferSize: string;
  printLocations: number;
  productCostMultiplier: number;
  pricingMode: string;
  decorationPriceBasis: string;
  tierPriceLane: string;
}

export interface ItemForwardOutputs {
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
}

export function getItemForwardScenario() {
  const s = scenariosJson.scenarios.find((s) => s.id === "item-forward-current")!;
  return {
    inputs: s.inputs as unknown as ItemForwardInputs,
    outputs: s.outputs as unknown as ItemForwardOutputs,
  };
}

// ---------------------------------------------------------------------------
// DTF tier scenario
// ---------------------------------------------------------------------------
export interface TierExpected {
  tier: string;
  minQty: number;
  maxQty: number;
  activeTotalDtfCogs: number;
  prices: { T1: number; T2: number; T3: number; T4: number };
  pricingBasis: string;
  costingQtyWorstCase: number;
}

export function getTierScenario(id: string) {
  const s = scenariosJson.scenarios.find((s) => s.id === id)!;
  return {
    inputs: s.inputs as unknown as { quantity: number },
    expected: s.expected as unknown as TierExpected,
  };
}

// ---------------------------------------------------------------------------
// Pooled flat-fee scenario
// ---------------------------------------------------------------------------
export interface PooledExpected {
  "Service Key": string;
  "Service": string;
  "Qty": number;
  "Unique Groups": number;
  "Pooled Length": number;
  "Pooled Purchase": number;
  "Base Length": number;
  "Base Purchase": number;
  "Add-On Placements / Shirt": number;
  "Incremental Material / Shirt": number;
  "Operator Operating Cost": number;
  "Extra Operator Labor": number;
  "Designer Labor": number;
  "Incremental COGS / Shirt": number;
  "T1 Price": number;
  "Engine Whole": number;
}

export interface PooledInputs {
  service: string;
  quantity: number;
}

export function getPooledScenario(id: string) {
  const s = scenariosJson.scenarios.find((s) => s.id === id)!;
  return {
    inputs: s.inputs as unknown as PooledInputs,
    expected: s.expected as unknown as PooledExpected,
  };
}

// ---------------------------------------------------------------------------
// Re-export raw scenarios for tests that only need simple fields
// ---------------------------------------------------------------------------
export function getScenario(id: string): Scenario {
  const s = scenariosJson.scenarios.find((s) => s.id === id);
  if (!s) throw new Error(`Scenario ${id} not found`);
  return s;
}

export { scenariosJson };
