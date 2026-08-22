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

// ---------------------------------------------------------------------------
// Flat-fee services from the contract (names only, no cost data)
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

type ProductMode = "catalog" | "manual";
type Role = "staff" | "manager";

type ItemQuote = StaffItemQuote | ManagerItemQuote;
type FlatFeeQuote = StaffFlatFeeQuote | ManagerFlatFeeQuote;

function isManagerItem(q: ItemQuote): q is ManagerItemQuote {
  return "commissionReserve" in q;
}
function isManagerFlatFee(q: FlatFeeQuote): q is ManagerFlatFeeQuote {
  return "engineCogs" in q;
}

function parseStrictPositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return n >= 1 ? n : null;
}

function isDecimalQuantity(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== "" && /^\d+\.\d*$/.test(trimmed);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function QuoteDeskClient({ catalog }: Props) {
  // Group catalog by category
  const categories = Array.from(new Set(catalog.map((p) => p.category)));

  // --- State ---
  const [role, setRole] = useState<Role>("staff");
  const [productMode, setProductMode] = useState<ProductMode>("catalog");
  const [selectedSku, setSelectedSku] = useState("");
  const [manualCost, setManualCost] = useState("");
  const [quantity, setQuantity] = useState("84");

  const [selectedService, setSelectedService] = useState("");
  const [flatFeeQuantity, setFlatFeeQuantity] = useState("");

  // Manager edits for flat-fee
  const [extraOpMinutes, setExtraOpMinutes] = useState("0");
  const [extraDesMinutes, setExtraDesMinutes] = useState("0");
  const [manualOverride, setManualOverride] = useState("");

  // Results
  const [itemQuote, setItemQuote] = useState<ItemQuote | null>(null);
  const [flatFeeQuote, setFlatFeeQuote] = useState<FlatFeeQuote | null>(null);
  const [itemLoading, setItemLoading] = useState(false);
  const [flatFeeLoading, setFlatFeeLoading] = useState(false);
  const [itemError, setItemError] = useState<string | null>(null);
  const [flatFeeError, setFlatFeeError] = useState<string | null>(null);
  const [managerReviewRequired, setManagerReviewRequired] = useState(false);

  // Abort controllers for debounced requests
  const itemAbort = useRef<AbortController | null>(null);
  const flatFeeAbort = useRef<AbortController | null>(null);

  // --- Item price calculation ---
  const calculateItem = useCallback(async () => {
    const qty = parseStrictPositiveInt(quantity);
    if (qty === null) return;

    let body: Record<string, unknown>;
    if (productMode === "catalog") {
      if (!selectedSku) return;
      body = { sku: selectedSku, quantity: qty };
    } else {
      const cost = parseFloat(manualCost);
      if (isNaN(cost) || cost < 0) return;
      body = { productCost: cost, quantity: qty };
    }

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
  }, [productMode, selectedSku, manualCost, quantity, role]);

  // --- Flat-fee calculation ---
  const calculateFlatFee = useCallback(async () => {
    if (!selectedService) return;
    const qty = parseStrictPositiveInt(flatFeeQuantity || quantity);
    if (qty === null) return;

    flatFeeAbort.current?.abort();
    const controller = new AbortController();
    flatFeeAbort.current = controller;

    setFlatFeeLoading(true);
    setFlatFeeError(null);
    try {
      const body: Record<string, unknown> = {
        service: selectedService,
        orderQuantity: qty,
        extraOperatorMinutesPerShirt: parseFloat(extraOpMinutes) || 0,
        extraDesignerMinutesPerOrder: parseFloat(extraDesMinutes) || 0,
        manualOverride: manualOverride === "" ? null : parseFloat(manualOverride),
      };

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
      const data: FlatFeeQuote = await res.json();
      setFlatFeeQuote(data);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setFlatFeeError((e as Error).message);
      }
    } finally {
      setFlatFeeLoading(false);
    }
  }, [selectedService, flatFeeQuantity, quantity, extraOpMinutes, extraDesMinutes, manualOverride, role]);

  // Auto-calculate item price when inputs change
  useEffect(() => {
    const timer = setTimeout(calculateItem, 300);
    return () => clearTimeout(timer);
  }, [calculateItem]);

  // Auto-calculate flat-fee when inputs change
  useEffect(() => {
    if (selectedService) {
      const timer = setTimeout(calculateFlatFee, 300);
      return () => clearTimeout(timer);
    }
  }, [calculateFlatFee, selectedService]);

  // --- Derived ---
  const selectedProduct = catalog.find((p) => p.sku === selectedSku);

  // Order total: item total + flat-fee add-on total
  const orderTotal =
    (itemQuote?.salesOrderTotal ?? 0) + (flatFeeQuote?.addOnTotal ?? 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-4 lg:py-6">
      {/* Role toggle */}
      <div className="flex items-center justify-end mb-4 gap-2">
        <span className="text-xs text-cmp-gray uppercase tracking-wider">
          View mode:
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
            Local evaluation only
          </span>
        )}
      </div>

      {/* Split pane: inputs left, summary right */}
      <div className="flex flex-col lg:flex-row gap-4 lg:gap-6">
        {/* LEFT: Inputs */}
        <div className="flex-1 space-y-4 min-w-0">
          {/* Product Selection */}
          <section className="cmp-card p-4 sm:p-5" aria-labelledby="product-heading">
            <h2
              id="product-heading"
              className="text-sm font-bold uppercase tracking-wider text-cmp-charcoal mb-3 font-display"
            >
              Product
            </h2>

            {/* Mode toggle */}
            <div className="flex gap-2 mb-3" role="group" aria-label="Product input mode">
              <button
                onClick={() => setProductMode("catalog")}
                aria-pressed={productMode === "catalog"}
                className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
                  productMode === "catalog"
                    ? "bg-cmp-cyan text-white"
                    : "bg-cmp-surface text-cmp-gray hover:text-cmp-charcoal"
                }`}
              >
                Catalog
              </button>
              <button
                onClick={() => setProductMode("manual")}
                aria-pressed={productMode === "manual"}
                className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
                  productMode === "manual"
                    ? "bg-cmp-cyan text-white"
                    : "bg-cmp-surface text-cmp-gray hover:text-cmp-charcoal"
                }`}
              >
                Manual Cost
              </button>
            </div>

            {productMode === "catalog" ? (
              <div>
                <label htmlFor="product-select" className="cmp-label">
                  Product
                </label>
                <select
                  id="product-select"
                  className="cmp-select"
                  value={selectedSku}
                  onChange={(e) => setSelectedSku(e.target.value)}
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
                <label htmlFor="manual-cost" className="cmp-label">
                  Product Cost ($)
                </label>
                <input
                  id="manual-cost"
                  type="number"
                  min="0"
                  step="0.01"
                  className="cmp-input"
                  value={manualCost}
                  onChange={(e) => setManualCost(e.target.value)}
                  placeholder="e.g. 3.95"
                />
              </div>
            )}
          </section>

          {/* Quantity */}
          <section className="cmp-card p-4 sm:p-5" aria-labelledby="quantity-heading">
            <h2
              id="quantity-heading"
              className="text-sm font-bold uppercase tracking-wider text-cmp-charcoal mb-3 font-display"
            >
              Quantity
            </h2>
            <label htmlFor="quantity-input" className="cmp-label">
              Order Quantity
            </label>
            <input
              id="quantity-input"
              type="number"
              min="1"
              step="1"
              className="cmp-input"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
            {isDecimalQuantity(quantity) && (
              <p className="mt-1 text-xs text-red-600" role="alert">
                Quantity must be a whole number.
              </p>
            )}
            {managerReviewRequired && (
              <p className="mt-2 text-xs text-cmp-warning flex items-center gap-1" role="status">
                <span className="inline-block w-4 h-4 rounded-full bg-amber-100 text-center leading-4 text-[10px] font-bold">!</span>
                Quantities over 5,000 require manager review.
              </p>
            )}
          </section>

          {/* DTF Assumptions (read-only) */}
          <section className="cmp-card p-4 sm:p-5" aria-labelledby="decoration-heading">
            <h2
              id="decoration-heading"
              className="text-sm font-bold uppercase tracking-wider text-cmp-charcoal mb-3 font-display"
            >
              Decoration
            </h2>
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
            <p className="mt-2 text-[11px] text-cmp-gray">
              Fixed P0 configuration. Adjustable geometry and locations are P1.
            </p>
          </section>

          {/* Flat-Fee Service */}
          <section className="cmp-card p-4 sm:p-5" aria-labelledby="flat-fee-heading">
            <h2
              id="flat-fee-heading"
              className="text-sm font-bold uppercase tracking-wider text-cmp-charcoal mb-3 font-display"
            >
              Add-On Service
            </h2>
            <label htmlFor="service-select" className="cmp-label">
              Service
            </label>
            <select
              id="service-select"
              className="cmp-select"
              value={selectedService}
              onChange={(e) => setSelectedService(e.target.value)}
            >
              <option value="">None</option>
              {FLAT_FEE_SERVICES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>

            {selectedService && (
              <div className="mt-3">
                <label htmlFor="flat-fee-qty" className="cmp-label">
                  Service Quantity (defaults to order qty)
                </label>
                <input
                  id="flat-fee-qty"
                  type="number"
                  min="1"
                  step="1"
                  className="cmp-input"
                  value={flatFeeQuantity}
                  onChange={(e) => setFlatFeeQuantity(e.target.value)}
                  placeholder={quantity}
                />
              </div>
            )}

            {/* Manager edits for flat-fee */}
            {selectedService && role === "manager" && (
              <div className="mt-4 pt-3 border-t border-cmp-gray-light/50 space-y-3">
                <p className="text-[11px] text-cmp-warning font-medium uppercase tracking-wider">
                  Manager Controls
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="extra-op-min" className="cmp-label">
                      Extra Op Min/Shirt
                    </label>
                    <input
                      id="extra-op-min"
                      type="number"
                      min="0"
                      step="0.5"
                      className="cmp-input"
                      value={extraOpMinutes}
                      onChange={(e) => setExtraOpMinutes(e.target.value)}
                    />
                  </div>
                  <div>
                    <label htmlFor="extra-des-min" className="cmp-label">
                      Extra Design Min/Order
                    </label>
                    <input
                      id="extra-des-min"
                      type="number"
                      min="0"
                      step="0.5"
                      className="cmp-input"
                      value={extraDesMinutes}
                      onChange={(e) => setExtraDesMinutes(e.target.value)}
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="manual-override" className="cmp-label">
                    Manual Override ($)
                  </label>
                  <input
                    id="manual-override"
                    type="number"
                    min="0"
                    step="0.01"
                    className="cmp-input"
                    value={manualOverride}
                    onChange={(e) => setManualOverride(e.target.value)}
                    placeholder="Blank = use engine/floor"
                  />
                </div>
              </div>
            )}
          </section>
        </div>

        {/* RIGHT: Summary */}
        <aside className="lg:w-96 lg:sticky lg:top-4 lg:self-start space-y-4">
          {/* Item Price Summary */}
          <div className="cmp-card p-4 sm:p-5" aria-labelledby="item-summary-heading">
            <h2
              id="item-summary-heading"
              className="text-sm font-bold uppercase tracking-wider text-cmp-charcoal mb-4 font-display"
            >
              Item Price
            </h2>

            {itemError && (
              <div
                className="mb-3 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700"
                role="alert"
              >
                {itemError}
              </div>
            )}

            {managerReviewRequired && (
              <div
                className="mb-3 rounded-md bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800 text-center"
                role="status"
                data-testid="manager-review-banner"
              >
                <span className="inline-block w-5 h-5 rounded-full bg-amber-100 text-center leading-5 text-xs font-bold mr-1.5">!</span>
                Manager review required. Quantities over 5,000 cannot be quoted automatically.
              </div>
            )}

            {itemLoading && !itemQuote && (
              <div className="flex items-center gap-2 text-sm text-cmp-gray py-4">
                <LoadingSpinner />
                Calculating...
              </div>
            )}

            {itemQuote && (
              <div className={itemLoading ? "opacity-60 transition-opacity" : ""}>
                {/* Hero price */}
                <div className="text-center mb-4">
                  <p className="text-xs text-cmp-gray uppercase tracking-wider mb-1">
                    Per-Item Price
                  </p>
                  <p className="cmp-price-hero" aria-label={`Per-item price: ${formatCurrency(itemQuote.salesPrice)}`}>
                    {formatCurrency(itemQuote.salesPrice)}
                  </p>
                  <p className="text-xs text-cmp-gray mt-1">
                    Tier: {itemQuote.tierLabel}
                  </p>
                </div>

                {/* Breakdown */}
                <div className="space-y-1.5 text-sm border-t border-cmp-gray-light/50 pt-3">
                  <Row label="Product Sell" value={formatCurrency(itemQuote.productSell)} />
                  <Row label="Decoration Sell" value={formatCurrency(itemQuote.decorationSell)} />
                  <Row
                    label="Sales Price"
                    value={formatCurrency(itemQuote.salesPrice)}
                    bold
                  />
                </div>

                {/* Manager details */}
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
                      value={formatCurrency(itemQuote.grossProfitBeforeCommission)}
                    />
                    <Row
                      label="Net Contribution"
                      value={formatCurrency(itemQuote.netContributionAfterCommission)}
                    />
                    <Row
                      label="Gross Margin"
                      value={formatPercent(itemQuote.combinedGrossMarginBeforeCommission)}
                    />
                    <Row
                      label="Contribution Margin"
                      value={formatPercent(itemQuote.contributionMarginAfterCommission)}
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
                        value={formatCurrency(itemQuote.productionCogsOrderTotal)}
                      />
                      <Row
                        label="Net Contribution Total"
                        value={formatCurrency(itemQuote.netContributionOrderTotal)}
                      />
                    </>
                  )}
                </div>
              </div>
            )}

            {!itemQuote && !itemLoading && !itemError && (
              <p className="text-sm text-cmp-gray py-4 text-center">
                Select a product and quantity to see pricing.
              </p>
            )}
          </div>

          {/* Flat-Fee Summary */}
          {selectedService && (
            <div className="cmp-card p-4 sm:p-5" aria-labelledby="flat-fee-summary-heading">
              <h2
                id="flat-fee-summary-heading"
                className="text-sm font-bold uppercase tracking-wider text-cmp-charcoal mb-4 font-display"
              >
                Add-On: {selectedService}
              </h2>

              {flatFeeError && (
                <div
                  className="mb-3 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700"
                  role="alert"
                >
                  {flatFeeError}
                </div>
              )}

              {flatFeeLoading && !flatFeeQuote && (
                <div className="flex items-center gap-2 text-sm text-cmp-gray py-4">
                  <LoadingSpinner />
                  Calculating...
                </div>
              )}

              {flatFeeQuote && (
                <div className={flatFeeLoading ? "opacity-60 transition-opacity" : ""}>
                  <div className="text-center mb-4">
                    <p className="text-xs text-cmp-gray uppercase tracking-wider mb-1">
                      Per-Shirt Price
                    </p>
                    <p className="cmp-price-hero" aria-label={`Add-on per-shirt price: ${formatCurrency(flatFeeQuote.effectivePrice)}`}>
                      {formatCurrency(flatFeeQuote.effectivePrice)}
                    </p>
                    <p className="text-xs text-cmp-gray mt-1">
                      {flatFeeQuote.status}
                    </p>
                  </div>

                  <div className="space-y-1.5 text-sm border-t border-cmp-gray-light/50 pt-3">
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

                  {/* Manager flat-fee details */}
                  {isManagerFlatFee(flatFeeQuote) && (
                    <div className="mt-3 pt-3 border-t border-cmp-gray-light/50 space-y-1.5 text-sm">
                      <p className="text-[11px] text-cmp-warning font-medium uppercase tracking-wider mb-2">
                        Internal Details
                      </p>
                      <Row label="Engine COGS" value={formatCurrency(flatFeeQuote.engineCogs)} />
                      <Row label="Engine Price" value={formatCurrency(flatFeeQuote.enginePrice)} />
                      <Row label="Policy Floor" value={formatCurrency(flatFeeQuote.policyFloor)} />
                      <Row label="Gross Margin" value={formatPercent(flatFeeQuote.grossMargin)} />
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
            </div>
          )}

          {/* Combined Order Total */}
          {itemQuote && (
            <div className="cmp-card p-4 sm:p-5 bg-cmp-charcoal text-white">
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

          {/* Mobile sticky total */}
          {itemQuote && (
            <div className="lg:hidden fixed bottom-0 inset-x-0 bg-cmp-charcoal px-4 py-3 flex items-center justify-between z-10 border-t border-cmp-gray/30">
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
        </aside>
      </div>

      {/* Spacer for mobile sticky bar */}
      {itemQuote && <div className="lg:hidden h-16" />}
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
      <span className={bold ? "font-semibold text-cmp-charcoal" : "text-cmp-charcoal"}>
        {value}
      </span>
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
