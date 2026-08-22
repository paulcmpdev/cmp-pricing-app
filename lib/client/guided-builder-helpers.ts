/**
 * Pure helper functions for the Guided Builder step flow.
 * No React, no API calls — just step navigation and state validation.
 */

export const STEPS = ["product", "quantity", "decoration", "review"] as const;
export type Step = (typeof STEPS)[number];

export const STEP_LABELS: Record<Step, string> = {
  product: "Product",
  quantity: "Quantity",
  decoration: "Decoration",
  review: "Review",
};

export type ProductMode = "catalog" | "manual";

export interface BuilderState {
  productMode: ProductMode;
  selectedSku: string;
  manualCost: string;
  quantity: string;
  selectedService: string;
  flatFeeQuantity: string;
  extraOpMinutes: string;
  extraDesMinutes: string;
  manualOverride: string;
}

export const INITIAL_STATE: BuilderState = {
  productMode: "catalog",
  selectedSku: "",
  manualCost: "",
  quantity: "84",
  selectedService: "",
  flatFeeQuantity: "",
  extraOpMinutes: "0",
  extraDesMinutes: "0",
  manualOverride: "",
};

/** Index of a step in the flow (0-based). */
export function stepIndex(step: Step): number {
  return STEPS.indexOf(step);
}

/** Whether back navigation is available from this step. */
export function canGoBack(step: Step): boolean {
  return stepIndex(step) > 0;
}

/** Whether forward navigation is available from this step. */
export function canGoNext(step: Step): boolean {
  return stepIndex(step) < STEPS.length - 1;
}

/** Previous step, or null if at the start. */
export function prevStep(step: Step): Step | null {
  const idx = stepIndex(step);
  return idx > 0 ? STEPS[idx - 1] : null;
}

/** Next step, or null if at the end. */
export function nextStep(step: Step): Step | null {
  const idx = stepIndex(step);
  return idx < STEPS.length - 1 ? STEPS[idx + 1] : null;
}

/** Whether the current step has valid inputs to proceed. */
export function isStepValid(step: Step, state: BuilderState): boolean {
  switch (step) {
    case "product":
      if (state.productMode === "catalog") {
        return state.selectedSku !== "";
      }
      const cost = parseFloat(state.manualCost);
      return !isNaN(cost) && cost >= 0;

    case "quantity": {
      return parseStrictPositiveInt(state.quantity) !== null;
    }

    case "decoration":
      // Fixed config in P0 — always valid
      return true;

    case "review":
      // Review is always reachable if prior steps pass
      return true;
  }
}

/** Strict positive integer parser: rejects decimals, returns null on failure. */
export function parseStrictPositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  if (n < 1) return null;
  return n;
}

/** Progress fraction (0–1) for the progress bar. */
export function progressFraction(step: Step): number {
  return (stepIndex(step) + 1) / STEPS.length;
}

/** Whether quantity needs manager review (> 5000). */
export function needsManagerReview(quantity: string): boolean {
  const qty = parseStrictPositiveInt(quantity);
  return qty !== null && qty > 5000;
}

/** Build the item quote API request body from builder state. */
export function buildItemRequestBody(
  state: BuilderState
): Record<string, unknown> | null {
  const qty = parseStrictPositiveInt(state.quantity);
  if (qty === null) return null;

  if (state.productMode === "catalog") {
    if (!state.selectedSku) return null;
    return { sku: state.selectedSku, quantity: qty };
  }
  const cost = parseFloat(state.manualCost);
  if (isNaN(cost) || cost < 0) return null;
  return { productCost: cost, quantity: qty };
}

/** Build the flat-fee quote API request body from builder state. */
export function buildFlatFeeRequestBody(
  state: BuilderState
): Record<string, unknown> | null {
  if (!state.selectedService) return null;
  const qty = parseStrictPositiveInt(state.flatFeeQuantity || state.quantity);
  if (qty === null) return null;

  return {
    service: state.selectedService,
    orderQuantity: qty,
    extraOperatorMinutesPerShirt: parseFloat(state.extraOpMinutes) || 0,
    extraDesignerMinutesPerOrder: parseFloat(state.extraDesMinutes) || 0,
    manualOverride:
      state.manualOverride === "" ? null : parseFloat(state.manualOverride),
  };
}
