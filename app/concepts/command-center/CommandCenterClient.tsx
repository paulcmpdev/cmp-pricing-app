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
  classifyMargin,
  marginBarWidth,
  computeOrderSummary,
  isHighVolume,
} from "@/lib/client/command-center-helpers";

// ---------------------------------------------------------------------------
// Constants
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
export default function CommandCenterClient({ catalog }: Props) {
  const categories = Array.from(new Set(catalog.map((p) => p.category)));

  // --- State ---
  const [role, setRole] = useState<Role>("staff");
  const [productMode, setProductMode] = useState<ProductMode>("catalog");
  const [selectedSku, setSelectedSku] = useState("");
  const [manualCost, setManualCost] = useState("");
  const [quantity, setQuantity] = useState("84");

  const [selectedService, setSelectedService] = useState("");
  const [flatFeeQuantity, setFlatFeeQuantity] = useState("");

  // Manager flat-fee controls
  const [extraOpMinutes, setExtraOpMinutes] = useState("0");
  const [extraDesMinutes, setExtraDesMinutes] = useState("0");
  const [manualOverride, setManualOverride] = useState("");

  // Manager audit panel visibility
  const [auditOpen, setAuditOpen] = useState(false);

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

  // --- API calls ---
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
        manualOverride:
          manualOverride === "" ? null : parseFloat(manualOverride),
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
      setFlatFeeQuote(await res.json());
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setFlatFeeError((e as Error).message);
      }
    } finally {
      setFlatFeeLoading(false);
    }
  }, [
    selectedService,
    flatFeeQuantity,
    quantity,
    extraOpMinutes,
    extraDesMinutes,
    manualOverride,
    role,
  ]);

  useEffect(() => {
    const timer = setTimeout(calculateItem, 300);
    return () => clearTimeout(timer);
  }, [calculateItem]);

  useEffect(() => {
    if (selectedService) {
      const timer = setTimeout(calculateFlatFee, 300);
      return () => clearTimeout(timer);
    }
  }, [calculateFlatFee, selectedService]);

  // --- Derived ---
  const selectedProduct = catalog.find((p) => p.sku === selectedSku);
  const parsedQty = parseStrictPositiveInt(quantity);
  const highVolume = parsedQty !== null && isHighVolume(parsedQty);
  const { grandTotal, hasAddOn } = computeOrderSummary(
    itemQuote?.salesOrderTotal ?? null,
    flatFeeQuote?.addOnTotal ?? null
  );
  const anyLoading = itemLoading || flatFeeLoading;

  // Auto-open audit panel in manager mode
  useEffect(() => {
    if (role === "manager") setAuditOpen(true);
  }, [role]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-4 lg:py-6">
      {/* ── Role Toggle ── */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {highVolume && (
            <span
              className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5"
              role="status"
            >
              Needs manager review
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-cmp-gray uppercase tracking-wider">
            Mode:
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
      </div>

      {/* ── Headline Price Band ── */}
      <section
        className="cmp-card px-5 py-4 mb-4"
        aria-labelledby="headline-heading"
      >
        <h2 id="headline-heading" className="sr-only">
          Price Summary
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

        {!itemQuote && !itemLoading && !itemError && !managerReviewRequired && (
          <p className="text-sm text-cmp-gray text-center py-2">
            Select a product and quantity to see pricing.
          </p>
        )}

        {!itemQuote && itemLoading && (
          <div className="flex items-center justify-center gap-2 text-sm text-cmp-gray py-4">
            <LoadingSpinner />
            Calculating...
          </div>
        )}

        {itemQuote && (
          <div className={anyLoading ? "opacity-60 transition-opacity" : ""}>
            {/* Price row: dominant per-item + order total */}
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-3">
              <div>
                <p className="text-[10px] text-cmp-gray uppercase tracking-widest mb-0.5">
                  Per-Item Sales Price
                </p>
                <p
                  className="text-4xl font-bold tracking-tight text-cmp-charcoal font-display leading-none"
                  aria-label={`Per-item price: ${formatCurrency(itemQuote.salesPrice)}`}
                >
                  {formatCurrency(itemQuote.salesPrice)}
                </p>
                <p className="text-xs text-cmp-gray mt-1">
                  Tier: {itemQuote.tierLabel}
                </p>
              </div>

              <div className="sm:text-right">
                <p className="text-[10px] text-cmp-gray uppercase tracking-widest mb-0.5">
                  Order Total
                </p>
                <p
                  className="text-2xl font-bold tracking-tight text-cmp-charcoal font-display leading-none"
                  aria-label={`Order total: ${formatCurrency(grandTotal)}`}
                >
                  {formatCurrency(grandTotal)}
                </p>
                {hasAddOn && (
                  <p className="text-[10px] text-cmp-gray mt-0.5">
                    Items + Add-On
                  </p>
                )}
              </div>
            </div>

            {/* Composition breakdown: inline additive */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm border-t border-cmp-gray-light/40 pt-3">
              <span className="text-cmp-gray text-xs">Product</span>
              <span className="font-medium text-cmp-charcoal">
                {formatCurrency(itemQuote.productSell)}
              </span>
              <span className="text-cmp-gray-light">+</span>
              <span className="text-cmp-gray text-xs">Decoration</span>
              <span className="font-medium text-cmp-charcoal">
                {formatCurrency(itemQuote.decorationSell)}
              </span>
              <span className="text-cmp-gray-light">=</span>
              <span className="font-semibold text-cmp-charcoal">
                {formatCurrency(itemQuote.salesPrice)}
              </span>

              {isManagerItem(itemQuote) && (
                <>
                  <span className="text-cmp-gray-light mx-1">|</span>
                  <span className="text-cmp-gray text-xs">Commission</span>
                  <span className="text-cmp-charcoal">
                    {formatCurrency(itemQuote.commissionReserve)}
                  </span>
                </>
              )}
            </div>

            {/* Add-on line (if active) */}
            {flatFeeQuote && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm mt-2">
                {flatFeeError && (
                  <span className="text-red-600 text-xs">{flatFeeError}</span>
                )}
                <span className="text-cmp-gray text-xs">Add-On</span>
                <span className="font-medium text-cmp-charcoal">
                  {flatFeeQuote.service}
                </span>
                <span className="text-cmp-gray text-xs">@</span>
                <span className="font-medium text-cmp-charcoal">
                  {formatCurrency(flatFeeQuote.effectivePrice)}/shirt
                </span>
                <span className="text-cmp-gray-light">&times;</span>
                <span className="text-cmp-charcoal">
                  {flatFeeQuote.billableQuantity}
                </span>
                <span className="text-cmp-gray-light">=</span>
                <span className="font-semibold text-cmp-charcoal">
                  {formatCurrency(flatFeeQuote.addOnTotal)}
                </span>
                <span
                  className="text-[10px] text-cmp-gray bg-cmp-surface rounded px-1.5 py-0.5"
                  aria-label={`Pricing status: ${flatFeeQuote.status}`}
                >
                  {flatFeeQuote.status}
                </span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── Controls Grid ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        {/* Product & Quantity */}
        <section className="cmp-card p-4" aria-labelledby="cc-product-heading">
          <h2
            id="cc-product-heading"
            className="text-xs font-bold uppercase tracking-wider text-cmp-charcoal mb-3 font-display"
          >
            Product &amp; Quantity
          </h2>

          {/* Mode pills */}
          <div className="flex gap-1.5 mb-3" role="group" aria-label="Product input mode">
            <button
              onClick={() => setProductMode("catalog")}
              aria-pressed={productMode === "catalog"}
              className={`text-[11px] px-2.5 py-1 rounded font-medium transition-colors ${
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
              className={`text-[11px] px-2.5 py-1 rounded font-medium transition-colors ${
                productMode === "manual"
                  ? "bg-cmp-cyan text-white"
                  : "bg-cmp-surface text-cmp-gray hover:text-cmp-charcoal"
              }`}
            >
              Manual
            </button>
          </div>

          <div className="space-y-2.5">
            {productMode === "catalog" ? (
              <div>
                <label htmlFor="cc-product-select" className="cmp-label">
                  Product
                </label>
                <select
                  id="cc-product-select"
                  className="cmp-select text-xs"
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
                  <p className="mt-1 text-[11px] text-cmp-gray truncate">
                    {selectedProduct.name}
                  </p>
                )}
              </div>
            ) : (
              <div>
                <label htmlFor="cc-manual-cost" className="cmp-label">
                  Product Cost ($)
                </label>
                <input
                  id="cc-manual-cost"
                  type="number"
                  min="0"
                  step="0.01"
                  className="cmp-input text-xs"
                  value={manualCost}
                  onChange={(e) => setManualCost(e.target.value)}
                  placeholder="e.g. 3.95"
                />
              </div>
            )}

            <div>
              <label htmlFor="cc-quantity" className="cmp-label">
                Order Quantity
              </label>
              <input
                id="cc-quantity"
                type="number"
                min="1"
                step="1"
                className="cmp-input text-xs"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
              {isDecimalQuantity(quantity) && (
                <p className="mt-1 text-xs text-red-600" role="alert">
                  Quantity must be a whole number.
                </p>
              )}
            </div>
          </div>
        </section>

        {/* Add-On Service */}
        <section className="cmp-card p-4" aria-labelledby="cc-addon-heading">
          <h2
            id="cc-addon-heading"
            className="text-xs font-bold uppercase tracking-wider text-cmp-charcoal mb-3 font-display"
          >
            Add-On Service
          </h2>

          <div className="space-y-2.5">
            <div>
              <label htmlFor="cc-service-select" className="cmp-label">
                Service
              </label>
              <select
                id="cc-service-select"
                className="cmp-select text-xs"
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
            </div>

            {selectedService && (
              <div>
                <label htmlFor="cc-flat-fee-qty" className="cmp-label">
                  Service Qty (defaults to order qty)
                </label>
                <input
                  id="cc-flat-fee-qty"
                  type="number"
                  min="1"
                  step="1"
                  className="cmp-input text-xs"
                  value={flatFeeQuantity}
                  onChange={(e) => setFlatFeeQuantity(e.target.value)}
                  placeholder={quantity}
                />
              </div>
            )}

            {flatFeeError && !flatFeeQuote && (
              <div
                className="rounded-md bg-red-50 border border-red-200 p-2 text-xs text-red-700"
                role="alert"
              >
                {flatFeeError}
              </div>
            )}

            {!selectedService && (
              <p className="text-[11px] text-cmp-gray pt-1">
                Optional. Select a flat-fee add-on to include in the order.
              </p>
            )}
          </div>
        </section>
      </div>

      {/* ── Decoration Config (compact single-line) ── */}
      <section
        className="cmp-card px-4 py-3 mb-4"
        aria-labelledby="cc-decoration-heading"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <h2
            id="cc-decoration-heading"
            className="text-xs font-bold uppercase tracking-wider text-cmp-charcoal font-display"
          >
            Decoration
          </h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-cmp-charcoal">
            <span>
              <span className="text-cmp-gray">Method</span> DTF
            </span>
            <span className="text-cmp-gray-light">|</span>
            <span>
              <span className="text-cmp-gray">Mode</span> Average
            </span>
            <span className="text-cmp-gray-light">|</span>
            <span>
              <span className="text-cmp-gray">Transfer</span> 10 &times; 10 in
            </span>
            <span className="text-cmp-gray-light">|</span>
            <span>
              <span className="text-cmp-gray">Locations</span> 1
            </span>
            <span className="text-cmp-gray-light">|</span>
            <span>
              <span className="text-cmp-gray">Lane</span> T1
            </span>
          </div>
          <span className="text-[10px] text-cmp-gray">
            Fixed P0 configuration
          </span>
        </div>
      </section>

      {/* ── Manager Audit Panel ── */}
      {role === "manager" && (
        <section
          className="cmp-card mb-4 overflow-hidden"
          aria-labelledby="cc-audit-heading"
          aria-label="Internal management information"
        >
          <button
            onClick={() => setAuditOpen(!auditOpen)}
            className="w-full flex items-center justify-between px-4 py-3 text-left focus-visible:outline-cmp-cyan"
            aria-expanded={auditOpen}
          >
            <h2
              id="cc-audit-heading"
              className="text-xs font-bold uppercase tracking-wider text-cmp-warning font-display"
            >
              Manager Audit Panel
            </h2>
            <svg
              className={`h-4 w-4 text-cmp-gray transition-transform ${auditOpen ? "rotate-180" : ""}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>

          {auditOpen && (
            <div
              className="px-4 pb-4 grid grid-cols-1 md:grid-cols-2 gap-4"
              aria-live="polite"
            >
              {/* Item Internals */}
              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-cmp-charcoal mb-2">
                  Item Internals
                </h3>
                {itemQuote && isManagerItem(itemQuote) ? (
                  <div className="space-y-1.5">
                    <AuditRow
                      label="Commission Reserve"
                      value={formatCurrency(itemQuote.commissionReserve)}
                    />
                    <AuditRow
                      label="Decoration COGS"
                      value={formatCurrency(itemQuote.totalDecorationCogs)}
                    />
                    <AuditRow
                      label="Total Production COGS"
                      value={formatCurrency(itemQuote.totalProductionCogs)}
                    />
                    <AuditRow
                      label="Gross Profit"
                      value={formatCurrency(
                        itemQuote.grossProfitBeforeCommission
                      )}
                    />
                    <AuditRow
                      label="Net Contribution"
                      value={formatCurrency(
                        itemQuote.netContributionAfterCommission
                      )}
                    />

                    {/* Margin bars */}
                    <div className="pt-2 space-y-2">
                      <MarginBar
                        label="Gross Margin"
                        value={itemQuote.combinedGrossMarginBeforeCommission}
                      />
                      <MarginBar
                        label="Contribution Margin"
                        value={itemQuote.contributionMarginAfterCommission}
                      />
                    </div>

                    <div className="pt-2 border-t border-cmp-gray-light/40 space-y-1.5">
                      <AuditRow
                        label="Order COGS"
                        value={formatCurrency(
                          itemQuote.productionCogsOrderTotal
                        )}
                      />
                      <AuditRow
                        label="Order Net Contribution"
                        value={formatCurrency(
                          itemQuote.netContributionOrderTotal
                        )}
                      />
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-cmp-gray">
                    {itemLoading
                      ? "Calculating..."
                      : "No item quote available."}
                  </p>
                )}
              </div>

              {/* Flat-Fee Internals + Manager Controls */}
              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-cmp-charcoal mb-2">
                  Flat-Fee Internals
                </h3>
                {selectedService && flatFeeQuote && isManagerFlatFee(flatFeeQuote) ? (
                  <div className="space-y-1.5">
                    <AuditRow
                      label="Engine COGS"
                      value={formatCurrency(flatFeeQuote.engineCogs)}
                    />
                    <AuditRow
                      label="Engine Price"
                      value={formatCurrency(flatFeeQuote.enginePrice)}
                    />
                    <AuditRow
                      label="Policy Floor"
                      value={formatCurrency(flatFeeQuote.policyFloor)}
                    />
                    <AuditRow
                      label="Operator Operating Cost"
                      value={formatCurrency(
                        flatFeeQuote.operatorOperatingCost
                      )}
                    />
                    <AuditRow
                      label="Extra Operator Labor"
                      value={formatCurrency(flatFeeQuote.extraOperatorLabor)}
                    />
                    <AuditRow
                      label="Extra Designer Labor"
                      value={formatCurrency(flatFeeQuote.extraDesignerLabor)}
                    />

                    <div className="pt-2">
                      <MarginBar
                        label="Gross Margin"
                        value={flatFeeQuote.grossMargin}
                      />
                    </div>

                    {/* Manager flat-fee controls */}
                    <div className="pt-3 mt-2 border-t border-cmp-gray-light/40 space-y-2.5">
                      <p className="text-[10px] text-cmp-warning font-medium uppercase tracking-wider">
                        Adjust
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label
                            htmlFor="cc-extra-op-min"
                            className="cmp-label"
                          >
                            Extra Op Min / Shirt
                          </label>
                          <input
                            id="cc-extra-op-min"
                            type="number"
                            min="0"
                            step="0.5"
                            className="cmp-input text-xs"
                            value={extraOpMinutes}
                            onChange={(e) => setExtraOpMinutes(e.target.value)}
                          />
                        </div>
                        <div>
                          <label
                            htmlFor="cc-extra-des-min"
                            className="cmp-label"
                          >
                            Extra Design Min / Order
                          </label>
                          <input
                            id="cc-extra-des-min"
                            type="number"
                            min="0"
                            step="0.5"
                            className="cmp-input text-xs"
                            value={extraDesMinutes}
                            onChange={(e) => setExtraDesMinutes(e.target.value)}
                          />
                        </div>
                      </div>
                      <div>
                        <label
                          htmlFor="cc-manual-override"
                          className="cmp-label"
                        >
                          Manual Override ($)
                        </label>
                        <input
                          id="cc-manual-override"
                          type="number"
                          min="0"
                          step="0.01"
                          className="cmp-input text-xs"
                          value={manualOverride}
                          onChange={(e) => setManualOverride(e.target.value)}
                          placeholder="Blank = use engine/floor"
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-cmp-gray">
                    {!selectedService
                      ? "No add-on service selected."
                      : flatFeeLoading
                        ? "Calculating..."
                        : "No flat-fee quote available."}
                  </p>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── Order Summary Bar ── */}
      {itemQuote && (
        <section
          className="cmp-card bg-cmp-charcoal text-white px-5 py-4 mb-4"
          aria-labelledby="cc-order-total-heading"
        >
          <h2 id="cc-order-total-heading" className="sr-only">
            Order Summary
          </h2>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <div>
                <span className="text-[10px] uppercase tracking-widest text-cmp-gray-light block">
                  Item Total
                </span>
                <span className="font-semibold font-display">
                  {formatCurrency(itemQuote.salesOrderTotal)}
                </span>
              </div>
              {hasAddOn && flatFeeQuote && (
                <>
                  <span className="text-cmp-gray-light text-lg leading-none">
                    +
                  </span>
                  <div>
                    <span className="text-[10px] uppercase tracking-widest text-cmp-gray-light block">
                      Add-On Total
                    </span>
                    <span className="font-semibold font-display">
                      {formatCurrency(flatFeeQuote.addOnTotal)}
                    </span>
                  </div>
                </>
              )}
            </div>
            <div className="text-right">
              <span className="text-[10px] uppercase tracking-widest text-cmp-gray-light block">
                Grand Total
              </span>
              <span
                className="text-2xl font-bold font-display tracking-tight text-cmp-cyan"
                aria-label={`Grand total: ${formatCurrency(grandTotal)}`}
              >
                {formatCurrency(grandTotal)}
              </span>
            </div>
          </div>
        </section>
      )}

      {/* Mobile sticky footer */}
      {itemQuote && (
        <div className="md:hidden fixed bottom-0 inset-x-0 bg-cmp-charcoal px-4 py-3 flex items-center justify-between z-10 border-t border-cmp-gray/30">
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
              {formatCurrency(grandTotal)}
            </p>
          </div>
        </div>
      )}

      {/* Spacer for mobile sticky bar */}
      {itemQuote && <div className="md:hidden h-16" />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AuditRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline gap-2 text-xs">
      <span className="text-cmp-gray">{label}</span>
      <span className="font-medium text-cmp-charcoal tabular-nums">
        {value}
      </span>
    </div>
  );
}

function MarginBar({ label, value }: { label: string; value: number }) {
  const level = classifyMargin(value);
  const width = marginBarWidth(value);
  const colorMap: Record<string, string> = {
    healthy: "bg-emerald-500",
    moderate: "bg-amber-400",
    thin: "bg-orange-500",
    negative: "bg-red-500",
  };
  const textMap: Record<string, string> = {
    healthy: "text-emerald-700",
    moderate: "text-amber-700",
    thin: "text-orange-700",
    negative: "text-red-700",
  };

  return (
    <div>
      <div className="flex justify-between items-baseline text-xs mb-0.5">
        <span className="text-cmp-gray">{label}</span>
        <span className={`font-medium tabular-nums ${textMap[level]}`}>
          {formatPercent(value)}
        </span>
      </div>
      <div
        className="h-1.5 bg-cmp-surface rounded-full overflow-hidden"
        role="meter"
        aria-label={`${label}: ${formatPercent(value)}`}
        aria-valuenow={Math.round(value * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full transition-all ${colorMap[level]}`}
          style={{ width: `${width}%` }}
        />
      </div>
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
