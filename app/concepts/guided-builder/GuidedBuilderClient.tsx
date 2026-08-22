"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type {
  CatalogEntry,
  StaffItemQuote,
  ManagerItemQuote,
  StaffFlatFeeQuote,
  ManagerFlatFeeQuote,
} from "@/lib/client/types";
import { formatCurrency, formatPercent } from "@/lib/client/format";
import {
  STEPS,
  STEP_LABELS,
  type Step,
  type BuilderState,
  INITIAL_STATE,
  canGoBack,
  canGoNext,
  prevStep,
  nextStep,
  isStepValid,
  progressFraction,
  needsManagerReview,
  buildItemRequestBody,
  buildFlatFeeRequestBody,
} from "@/lib/client/guided-builder-helpers";

// ---------------------------------------------------------------------------
// Flat-fee services (names only — no cost data on client)
// ---------------------------------------------------------------------------
const FLAT_FEE_SERVICES = [
  "Additional Large Print",
  "Sleeve Print",
  "Bottom / Upper Chest",
  "Vertical Print",
  "Name",
  "Number",
  "Name + Number",
  "Standard Package",
  "Premium Package",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Props {
  catalog: CatalogEntry[];
}

type Role = "staff" | "manager";
type ItemQuote = StaffItemQuote | ManagerItemQuote;
type FlatFeeQuote = StaffFlatFeeQuote | ManagerFlatFeeQuote;

function isManagerItem(q: ItemQuote): q is ManagerItemQuote {
  return "commissionReserve" in q;
}
function isManagerFlatFee(q: FlatFeeQuote): q is ManagerFlatFeeQuote {
  return "engineCogs" in q;
}

function isDecimalQuantity(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== "" && /^\d+\.\d*$/.test(trimmed);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function GuidedBuilderClient({ catalog }: Props) {
  const categories = Array.from(new Set(catalog.map((p) => p.category)));

  // --- State ---
  const [currentStep, setCurrentStep] = useState<Step>("product");
  const [role, setRole] = useState<Role>("staff");
  const [state, setState] = useState<BuilderState>(INITIAL_STATE);

  // Results
  const [itemQuote, setItemQuote] = useState<ItemQuote | null>(null);
  const [flatFeeQuote, setFlatFeeQuote] = useState<FlatFeeQuote | null>(null);
  const [itemLoading, setItemLoading] = useState(false);
  const [flatFeeLoading, setFlatFeeLoading] = useState(false);
  const [itemError, setItemError] = useState<string | null>(null);
  const [flatFeeError, setFlatFeeError] = useState<string | null>(null);
  const [managerReviewRequired, setManagerReviewRequired] = useState(false);

  const itemAbort = useRef<AbortController | null>(null);
  const flatFeeAbort = useRef<AbortController | null>(null);

  // --- State updaters ---
  const update = useCallback(
    (patch: Partial<BuilderState>) =>
      setState((s) => ({ ...s, ...patch })),
    []
  );

  // --- API calls ---
  const calculateItem = useCallback(async () => {
    const body = buildItemRequestBody(state);
    if (!body) return;

    itemAbort.current?.abort();
    const controller = new AbortController();
    itemAbort.current = controller;

    setItemLoading(true);
    setItemError(null);
    setManagerReviewRequired(false);
    try {
      const res = await fetch("/api/quote/item", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cmp-role": role,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(
          err.error ? JSON.stringify(err.error) : `HTTP ${res.status}`
        );
      }
      const data = await res.json();
      if (data.requiresManagerReview && !("salesPrice" in data)) {
        setManagerReviewRequired(true);
        setItemQuote(null);
      } else {
        setItemQuote(data as ItemQuote);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setItemError((e as Error).message);
      }
    } finally {
      setItemLoading(false);
    }
  }, [state, role]);

  const calculateFlatFee = useCallback(async () => {
    const body = buildFlatFeeRequestBody(state);
    if (!body) return;

    flatFeeAbort.current?.abort();
    const controller = new AbortController();
    flatFeeAbort.current = controller;

    setFlatFeeLoading(true);
    setFlatFeeError(null);
    try {
      const res = await fetch("/api/quote/flat-fee", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cmp-role": role,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(
          err.error ? JSON.stringify(err.error) : `HTTP ${res.status}`
        );
      }
      setFlatFeeQuote(await res.json());
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setFlatFeeError((e as Error).message);
      }
    } finally {
      setFlatFeeLoading(false);
    }
  }, [state, role]);

  // Fetch quotes when arriving at review step
  useEffect(() => {
    if (currentStep === "review") {
      const t1 = setTimeout(calculateItem, 100);
      const t2 = state.selectedService
        ? setTimeout(calculateFlatFee, 100)
        : undefined;
      return () => {
        clearTimeout(t1);
        if (t2) clearTimeout(t2);
      };
    }
  }, [currentStep, calculateItem, calculateFlatFee, state.selectedService]);

  // Re-fetch when role changes on review step
  useEffect(() => {
    if (currentStep === "review" && itemQuote) {
      calculateItem();
      if (state.selectedService) calculateFlatFee();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  // --- Navigation ---
  const goNext = () => {
    if (!isStepValid(currentStep, state)) return;
    const next = nextStep(currentStep);
    if (next) setCurrentStep(next);
  };
  const goBack = () => {
    const prev = prevStep(currentStep);
    if (prev) setCurrentStep(prev);
  };

  // --- Derived ---
  const selectedProduct = catalog.find((p) => p.sku === state.selectedSku);
  const orderTotal =
    (itemQuote?.salesOrderTotal ?? 0) + (flatFeeQuote?.addOnTotal ?? 0);

  return (
    <div className="mx-auto max-w-lg px-4 py-4 sm:py-6">
      {/* Progress bar */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          {STEPS.map((s, i) => (
            <div
              key={s}
              className={`flex items-center gap-1.5 text-xs font-medium ${
                s === currentStep
                  ? "text-cmp-cyan"
                  : i < STEPS.indexOf(currentStep)
                  ? "text-cmp-charcoal"
                  : "text-cmp-gray"
              }`}
            >
              <span
                className={`flex items-center justify-center h-6 w-6 rounded-full text-[11px] font-bold ${
                  s === currentStep
                    ? "bg-cmp-cyan text-white"
                    : i < STEPS.indexOf(currentStep)
                    ? "bg-cmp-charcoal text-white"
                    : "bg-cmp-gray-light text-cmp-gray"
                }`}
              >
                {i < STEPS.indexOf(currentStep) ? "\u2713" : i + 1}
              </span>
              <span className="hidden sm:inline">{STEP_LABELS[s]}</span>
            </div>
          ))}
        </div>
        <div className="h-1.5 bg-cmp-gray-light/50 rounded-full overflow-hidden">
          <div
            className="h-full bg-cmp-cyan rounded-full transition-all duration-300"
            style={{ width: `${progressFraction(currentStep) * 100}%` }}
          />
        </div>
      </div>

      {/* Role toggle */}
      <div className="flex items-center justify-end mb-4 gap-2">
        <span className="text-xs text-cmp-gray uppercase tracking-wider">
          View:
        </span>
        <button
          onClick={() => setRole(role === "staff" ? "manager" : "staff")}
          className={`relative inline-flex h-7 w-14 items-center rounded-full transition-colors focus-visible:outline-cmp-cyan ${
            role === "manager" ? "bg-cmp-cyan" : "bg-cmp-gray-light"
          }`}
          role="switch"
          aria-checked={role === "manager"}
          aria-label="Toggle Manager mode"
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
              role === "manager" ? "translate-x-8" : "translate-x-1"
            }`}
          />
        </button>
        <span className="text-xs font-medium min-w-[56px]">
          {role === "manager" ? "Manager" : "Staff"}
        </span>
        {role === "manager" && (
          <span className="text-[10px] text-cmp-warning bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
            Local only
          </span>
        )}
      </div>

      {/* Step content */}
      <div className="cmp-card p-5 sm:p-6 mb-4">
        <h2 className="text-lg font-bold text-cmp-charcoal mb-4 font-display">
          {STEP_LABELS[currentStep]}
        </h2>

        {/* ----- PRODUCT STEP ----- */}
        {currentStep === "product" && (
          <div className="space-y-4">
            <div className="flex gap-2" role="group" aria-label="Product input mode">
              <button
                onClick={() => update({ productMode: "catalog" })}
                aria-pressed={state.productMode === "catalog"}
                className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
                  state.productMode === "catalog"
                    ? "bg-cmp-cyan text-white"
                    : "bg-cmp-surface text-cmp-gray hover:text-cmp-charcoal"
                }`}
              >
                Catalog
              </button>
              <button
                onClick={() => update({ productMode: "manual" })}
                aria-pressed={state.productMode === "manual"}
                className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
                  state.productMode === "manual"
                    ? "bg-cmp-cyan text-white"
                    : "bg-cmp-surface text-cmp-gray hover:text-cmp-charcoal"
                }`}
              >
                Manual Cost
              </button>
            </div>

            {state.productMode === "catalog" ? (
              <div>
                <label htmlFor="gb-product-select" className="cmp-label">
                  Product
                </label>
                <select
                  id="gb-product-select"
                  className="cmp-select"
                  value={state.selectedSku}
                  onChange={(e) => update({ selectedSku: e.target.value })}
                >
                  <option value="">Select a product...</option>
                  {categories.map((cat) => (
                    <optgroup key={cat} label={cat}>
                      {catalog
                        .filter((p) => p.category === cat)
                        .map((p) => (
                          <option key={p.sku} value={p.sku}>
                            {p.sku} &mdash; {p.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
                {selectedProduct && (
                  <p className="mt-1.5 text-xs text-cmp-gray">
                    {selectedProduct.name}
                  </p>
                )}
              </div>
            ) : (
              <div>
                <label htmlFor="gb-manual-cost" className="cmp-label">
                  Product Cost ($)
                </label>
                <input
                  id="gb-manual-cost"
                  type="number"
                  min="0"
                  step="0.01"
                  className="cmp-input"
                  value={state.manualCost}
                  onChange={(e) => update({ manualCost: e.target.value })}
                  placeholder="e.g. 3.95"
                />
              </div>
            )}
          </div>
        )}

        {/* ----- QUANTITY STEP ----- */}
        {currentStep === "quantity" && (
          <div className="space-y-4">
            <div>
              <label htmlFor="gb-quantity" className="cmp-label">
                Order Quantity
              </label>
              <input
                id="gb-quantity"
                type="number"
                min="1"
                step="1"
                className="cmp-input"
                value={state.quantity}
                onChange={(e) => update({ quantity: e.target.value })}
              />
              {isDecimalQuantity(state.quantity) && (
                <p className="mt-1 text-xs text-red-600" role="alert">
                  Quantity must be a whole number.
                </p>
              )}
              {needsManagerReview(state.quantity) && (
                <p className="mt-2 text-xs text-cmp-warning flex items-center gap-1">
                  <span className="inline-block w-4 h-4 rounded-full bg-amber-100 text-center leading-4 text-[10px] font-bold">!</span>
                  Quantities over 5,000 require manager review.
                </p>
              )}
            </div>

            {/* Confirmed product summary */}
            <div className="bg-cmp-surface rounded-md p-3">
              <p className="cmp-label">Selected Product</p>
              <p className="text-sm font-medium text-cmp-charcoal">
                {state.productMode === "catalog"
                  ? selectedProduct
                    ? `${selectedProduct.sku} — ${selectedProduct.name}`
                    : "—"
                  : `Manual Cost: $${state.manualCost}`}
              </p>
            </div>
          </div>
        )}

        {/* ----- DECORATION STEP ----- */}
        {currentStep === "decoration" && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="cmp-label">Method</span>
                <p className="cmp-value-readonly">DTF</p>
              </div>
              <div>
                <span className="cmp-label">Mode</span>
                <p className="cmp-value-readonly">Average</p>
              </div>
              <div>
                <span className="cmp-label">Transfer Size</span>
                <p className="cmp-value-readonly">10 &times; 10 in</p>
              </div>
              <div>
                <span className="cmp-label">Included Locations</span>
                <p className="cmp-value-readonly">1</p>
              </div>
              <div>
                <span className="cmp-label">Price Lane</span>
                <p className="cmp-value-readonly">Tier Matrix, T1</p>
              </div>
            </div>
            <p className="text-[11px] text-cmp-gray">
              Fixed P0 configuration. Adjustable geometry and locations are P1.
            </p>

            {/* Optional flat-fee add-on */}
            <div className="pt-3 border-t border-cmp-gray-light/50">
              <label htmlFor="gb-service-select" className="cmp-label">
                Add-On Service (optional)
              </label>
              <select
                id="gb-service-select"
                className="cmp-select"
                value={state.selectedService}
                onChange={(e) => update({ selectedService: e.target.value })}
              >
                <option value="">None</option>
                {FLAT_FEE_SERVICES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>

              {state.selectedService && (
                <div className="mt-3">
                  <label htmlFor="gb-flat-fee-qty" className="cmp-label">
                    Service Quantity (defaults to order qty)
                  </label>
                  <input
                    id="gb-flat-fee-qty"
                    type="number"
                    min="1"
                    step="1"
                    className="cmp-input"
                    value={state.flatFeeQuantity}
                    onChange={(e) =>
                      update({ flatFeeQuantity: e.target.value })
                    }
                    placeholder={state.quantity}
                  />
                </div>
              )}

              {/* Manager controls for flat-fee */}
              {state.selectedService && role === "manager" && (
                <div className="mt-4 pt-3 border-t border-cmp-gray-light/50 space-y-3">
                  <p className="text-[11px] text-cmp-warning font-medium uppercase tracking-wider">
                    Manager Controls
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="gb-extra-op" className="cmp-label">
                        Extra Op Min/Shirt
                      </label>
                      <input
                        id="gb-extra-op"
                        type="number"
                        min="0"
                        step="0.5"
                        className="cmp-input"
                        value={state.extraOpMinutes}
                        onChange={(e) =>
                          update({ extraOpMinutes: e.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label htmlFor="gb-extra-des" className="cmp-label">
                        Extra Design Min/Order
                      </label>
                      <input
                        id="gb-extra-des"
                        type="number"
                        min="0"
                        step="0.5"
                        className="cmp-input"
                        value={state.extraDesMinutes}
                        onChange={(e) =>
                          update({ extraDesMinutes: e.target.value })
                        }
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="gb-manual-override" className="cmp-label">
                      Manual Override ($)
                    </label>
                    <input
                      id="gb-manual-override"
                      type="number"
                      min="0"
                      step="0.01"
                      className="cmp-input"
                      value={state.manualOverride}
                      onChange={(e) =>
                        update({ manualOverride: e.target.value })
                      }
                      placeholder="Blank = use engine/floor"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ----- REVIEW STEP ----- */}
        {currentStep === "review" && (
          <div className="space-y-5">
            {/* Input summary */}
            <div className="space-y-2 text-sm">
              <div className="bg-cmp-surface rounded-md p-3 space-y-1.5">
                <SummaryRow
                  label="Product"
                  value={
                    state.productMode === "catalog"
                      ? selectedProduct
                        ? `${selectedProduct.sku} — ${selectedProduct.name}`
                        : "—"
                      : `Manual: $${state.manualCost}`
                  }
                />
                <SummaryRow label="Quantity" value={state.quantity} />
                <SummaryRow label="Decoration" value="DTF, T1, 10×10 in" />
                {state.selectedService && (
                  <SummaryRow label="Add-On" value={state.selectedService} />
                )}
              </div>
            </div>

            {/* Errors */}
            {itemError && (
              <div
                className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700"
                role="alert"
              >
                {itemError}
              </div>
            )}
            {flatFeeError && (
              <div
                className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700"
                role="alert"
              >
                {flatFeeError}
              </div>
            )}

            {managerReviewRequired && (
              <div
                className="rounded-md bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800 text-center"
                role="status"
                data-testid="manager-review-banner"
              >
                <span className="inline-block w-5 h-5 rounded-full bg-amber-100 text-center leading-5 text-xs font-bold mr-1.5">!</span>
                Manager review required. Quantities over 5,000 cannot be quoted automatically.
              </div>
            )}

            {/* Loading */}
            {(itemLoading || flatFeeLoading) && !itemQuote && (
              <div className="flex items-center justify-center gap-2 text-sm text-cmp-gray py-6">
                <LoadingSpinner />
                Calculating your quote...
              </div>
            )}

            {/* Item quote results */}
            {itemQuote && (
              <div className={itemLoading ? "opacity-60 transition-opacity" : ""}>
                {/* Hero price */}
                <div className="text-center mb-4">
                  <p className="text-xs text-cmp-gray uppercase tracking-wider mb-1">
                    Per-Item Price
                  </p>
                  <p
                    className="cmp-price-hero"
                    aria-label={`Per-item price: ${formatCurrency(itemQuote.salesPrice)}`}
                  >
                    {formatCurrency(itemQuote.salesPrice)}
                  </p>
                  <p className="text-xs text-cmp-gray mt-1">
                    Tier: {itemQuote.tierLabel}
                  </p>
                </div>

                {/* Price breakdown */}
                <div className="space-y-1.5 text-sm border-t border-cmp-gray-light/50 pt-3">
                  <Row
                    label="Product Sell"
                    value={formatCurrency(itemQuote.productSell)}
                  />
                  <Row
                    label="Decoration Sell"
                    value={formatCurrency(itemQuote.decorationSell)}
                  />
                  <Row
                    label="Sales Price"
                    value={formatCurrency(itemQuote.salesPrice)}
                    bold
                  />
                </div>

                {/* Manager internals */}
                {isManagerItem(itemQuote) && (
                  <div className="mt-3 pt-3 border-t border-cmp-gray-light/50 space-y-1.5 text-sm">
                    <p className="text-[11px] text-cmp-warning font-medium uppercase tracking-wider mb-2">
                      Internal Details
                    </p>
                    <Row
                      label="Commission Reserve"
                      value={formatCurrency(itemQuote.commissionReserve)}
                    />
                    <Row
                      label="Decoration COGS"
                      value={formatCurrency(itemQuote.totalDecorationCogs)}
                    />
                    <Row
                      label="Total Production COGS"
                      value={formatCurrency(itemQuote.totalProductionCogs)}
                    />
                    <Row
                      label="Gross Profit"
                      value={formatCurrency(
                        itemQuote.grossProfitBeforeCommission
                      )}
                    />
                    <Row
                      label="Net Contribution"
                      value={formatCurrency(
                        itemQuote.netContributionAfterCommission
                      )}
                    />
                    <Row
                      label="Gross Margin"
                      value={formatPercent(
                        itemQuote.combinedGrossMarginBeforeCommission
                      )}
                    />
                    <Row
                      label="Contribution Margin"
                      value={formatPercent(
                        itemQuote.contributionMarginAfterCommission
                      )}
                    />
                  </div>
                )}

                {/* Order totals */}
                <div className="mt-3 pt-3 border-t border-cmp-gray-light/50 space-y-1.5 text-sm">
                  <Row
                    label="Item Order Total"
                    value={formatCurrency(itemQuote.salesOrderTotal)}
                    bold
                  />
                  {isManagerItem(itemQuote) && (
                    <>
                      <Row
                        label="Production COGS Total"
                        value={formatCurrency(
                          itemQuote.productionCogsOrderTotal
                        )}
                      />
                      <Row
                        label="Net Contribution Total"
                        value={formatCurrency(
                          itemQuote.netContributionOrderTotal
                        )}
                      />
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Flat-fee results */}
            {flatFeeQuote && (
              <div
                className={`mt-4 pt-4 border-t border-cmp-gray-light/50 ${
                  flatFeeLoading ? "opacity-60 transition-opacity" : ""
                }`}
              >
                <h3 className="text-sm font-bold uppercase tracking-wider text-cmp-charcoal mb-3 font-display">
                  Add-On: {flatFeeQuote.service}
                </h3>
                <div className="text-center mb-3">
                  <p className="text-xs text-cmp-gray uppercase tracking-wider mb-1">
                    Per-Shirt Price
                  </p>
                  <p
                    className="text-2xl font-bold tracking-tight text-cmp-charcoal font-display"
                    aria-label={`Add-on per-shirt price: ${formatCurrency(flatFeeQuote.effectivePrice)}`}
                  >
                    {formatCurrency(flatFeeQuote.effectivePrice)}
                  </p>
                  <p className="text-xs text-cmp-gray mt-1">
                    {flatFeeQuote.status}
                  </p>
                </div>
                <div className="space-y-1.5 text-sm">
                  <Row
                    label="Billable Quantity"
                    value={String(flatFeeQuote.billableQuantity)}
                  />
                  <Row
                    label="Add-On Total"
                    value={formatCurrency(flatFeeQuote.addOnTotal)}
                    bold
                  />
                </div>

                {isManagerFlatFee(flatFeeQuote) && (
                  <div className="mt-3 pt-3 border-t border-cmp-gray-light/50 space-y-1.5 text-sm">
                    <p className="text-[11px] text-cmp-warning font-medium uppercase tracking-wider mb-2">
                      Internal Details
                    </p>
                    <Row
                      label="Engine COGS"
                      value={formatCurrency(flatFeeQuote.engineCogs)}
                    />
                    <Row
                      label="Engine Price"
                      value={formatCurrency(flatFeeQuote.enginePrice)}
                    />
                    <Row
                      label="Policy Floor"
                      value={formatCurrency(flatFeeQuote.policyFloor)}
                    />
                    <Row
                      label="Gross Margin"
                      value={formatPercent(flatFeeQuote.grossMargin)}
                    />
                    <Row
                      label="Operator Operating Cost"
                      value={formatCurrency(flatFeeQuote.operatorOperatingCost)}
                    />
                    <Row
                      label="Extra Operator Labor"
                      value={formatCurrency(flatFeeQuote.extraOperatorLabor)}
                    />
                    <Row
                      label="Extra Designer Labor"
                      value={formatCurrency(flatFeeQuote.extraDesignerLabor)}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Combined order total */}
            {itemQuote && (
              <div className="bg-cmp-charcoal text-white rounded-lg p-4 mt-4">
                <p className="text-xs uppercase tracking-wider text-cmp-gray-light mb-1">
                  Order Total
                </p>
                <p
                  className="text-3xl font-bold tracking-tight font-display"
                  aria-label={`Order total: ${formatCurrency(orderTotal)}`}
                >
                  {formatCurrency(orderTotal)}
                </p>
                {flatFeeQuote && (
                  <p className="text-xs text-cmp-gray-light mt-1">
                    Items + Add-On
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Navigation buttons */}
      <div className="flex items-center gap-3">
        {canGoBack(currentStep) && (
          <button
            onClick={goBack}
            className="cmp-btn-secondary flex-1 sm:flex-none"
          >
            Back
          </button>
        )}
        <div className="flex-1" />
        {canGoNext(currentStep) ? (
          <button
            onClick={goNext}
            disabled={!isStepValid(currentStep, state)}
            className="cmp-btn-primary flex-1 sm:flex-none"
          >
            Next
          </button>
        ) : (
          <button
            onClick={() => setCurrentStep("product")}
            className="cmp-btn-secondary flex-1 sm:flex-none"
          >
            Start Over
          </button>
        )}
      </div>

      {/* Mobile sticky total on review */}
      {currentStep === "review" && itemQuote && (
        <div className="sm:hidden fixed bottom-0 inset-x-0 bg-cmp-charcoal px-4 py-3 flex items-center justify-between z-10 border-t border-cmp-gray/30">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-cmp-gray-light">
              Per Item
            </p>
            <p className="text-lg font-bold text-white font-display">
              {formatCurrency(itemQuote.salesPrice)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-cmp-gray-light">
              Order Total
            </p>
            <p className="text-lg font-bold text-cmp-cyan font-display">
              {formatCurrency(orderTotal)}
            </p>
          </div>
        </div>
      )}
      {/* Spacer for mobile sticky */}
      {currentStep === "review" && itemQuote && (
        <div className="sm:hidden h-16" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex justify-between items-baseline gap-2">
      <span className="text-cmp-gray text-xs">{label}</span>
      <span
        className={
          bold ? "font-semibold text-cmp-charcoal" : "text-cmp-charcoal"
        }
      >
        {value}
      </span>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline gap-2">
      <span className="text-xs text-cmp-gray">{label}</span>
      <span className="text-sm font-medium text-cmp-charcoal">{value}</span>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <svg
      className="animate-spin h-4 w-4 text-cmp-cyan"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
