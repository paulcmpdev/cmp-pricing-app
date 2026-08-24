"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fmtCurrency,
  fmtPercent,
  fmtWholePercent,
  fmtQtyRange,
  fmtDelta,
  fmtDeltaPercent,
  marginWarning,
} from "./pricing-helpers";

const LANES = ["T1", "T2", "T3", "T4"] as const;
type Lane = (typeof LANES)[number];
const DEBOUNCE_MS = 400;

type Trace = {
  baseDtfCogs: string;
  laborRecovery: string;
  targetMargin: string;
  marginLoadedAmount: string;
  raw: string;
  increment: string;
  final: string;
  achievedMargin: string;
};

type LaneData = {
  currentMargin: string;
  draftMargin: string;
  edited: boolean;
  current: Trace;
  draft: Trace;
};

type TierData = {
  tier: string;
  minQty: number;
  maxQty: number;
  activeTotalDtfCogs: string;
  baseDtfCogs: string;
  laborRecovery: string;
  lanes: Record<Lane, LaneData>;
};

type PricingPolicy = {
  productCostMultiplier: number;
  commissionReserveRate: number;
  roundingIncrement: string;
};

type DtfContext = {
  activeProductionMode: string;
  pricingMode: string;
  sharedProjectLaborPerOrder: string;
  capturedTransferSizeIn: { width: number; height: number };
  sheetWidthIn: number;
  spacingIn: number;
};

type PreviewResponse = {
  schemaVersion: string;
  source: string;
  pricingPolicy: PricingPolicy;
  dtfContext: DtfContext;
  tiers: TierData[];
};

type QuoteTotals = {
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

type QuoteResponse = {
  tier: string;
  lane: string;
  productCost: string;
  quantity: number;
  contributionBasis: string;
  current: QuoteTotals;
  draft: QuoteTotals;
  delta: {
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
};

type Edit = { tier: string; lane: Lane; marginPercent: number };

type MarginErrors = Map<string, string>;

type QuoteFieldErrors = {
  productCost?: string;
  quantity?: string;
};

function validateMargin(value: number): string | null {
  if (!Number.isFinite(value)) return "Enter a number";
  if (value < 0) return "Min 0%";
  if (value >= 100) return "Max 99%";
  return null;
}

function validateQuoteInputs(inputs: {
  productCost: string;
  quantity: string;
}): QuoteFieldErrors {
  const errors: QuoteFieldErrors = {};
  const cost = parseFloat(inputs.productCost);
  const qty = parseFloat(inputs.quantity);

  if (inputs.productCost !== "" && (!Number.isFinite(cost) || cost < 0)) {
    errors.productCost = "Must be >= 0";
  }
  if (inputs.quantity !== "") {
    if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < 1 || qty > 5000) {
      errors.quantity = "Integer 1-5,000";
    }
  }
  return errors;
}

function hasValidMargins(edits: Map<string, Edit>): boolean {
  for (const edit of Array.from(edits.values())) {
    if (validateMargin(edit.marginPercent) !== null) return false;
  }
  return true;
}

export default function PricingPreview() {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [quoteResult, setQuoteResult] = useState<QuoteResponse | null>(null);
  const [edits, setEdits] = useState<Map<string, Edit>>(new Map());
  const [loading, setLoading] = useState(true);
  const [recalculating, setRecalculating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedCell, setSelectedCell] = useState<{ tier: string; lane: Lane } | null>(null);
  const [quoteInputs, setQuoteInputs] = useState({
    productCost: "4.80",
    quantity: "174",
    lane: "T1" as Lane,
  });
  const [marginErrors, setMarginErrors] = useState<MarginErrors>(new Map());
  const [quoteErrors, setQuoteErrors] = useState<QuoteFieldErrors>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestTokenRef = useRef(0);
  const dirtyRef = useRef(false);

  const isDirty = edits.size > 0;

  useEffect(() => {
    dirtyRef.current = isDirty;
  }, [isDirty]);

  // beforeunload warning
  useEffect(() => {
    function handler(e: BeforeUnloadEvent) {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  const fetchPreview = useCallback(
    async (
      editList: Edit[],
      quote: { productCost: string; quantity: string; lane: Lane },
      qErrors: QuoteFieldErrors
    ) => {
      // Abort any previous in-flight request
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const token = ++requestTokenRef.current;
      setRecalculating(true);
      setError(null);

      try {
        const body: Record<string, unknown> = {
          edits: editList.map((e) => ({
            tier: e.tier,
            lane: e.lane,
            marginPercent: e.marginPercent,
          })),
        };

        // Only include quote if inputs are valid
        const productCost = parseFloat(quote.productCost);
        const quantity = parseInt(quote.quantity, 10);
        const quoteIsValid =
          !qErrors.productCost &&
          !qErrors.quantity &&
          Number.isFinite(productCost) &&
          Number.isFinite(quantity) &&
          quantity >= 1;
        if (quoteIsValid) {
          body.quote = { productCost, quantity, lane: quote.lane };
        }

        const res = await fetch("/api/admin/pricing/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        // Stale response guard: only apply if this is still the latest request
        if (token !== requestTokenRef.current) return;

        if (res.status === 404) {
          setError("Pricing preview is disabled in this environment.");
          return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          // Parse field-level errors from API
          if (data?.error && typeof data.error === "object" && !Array.isArray(data.error)) {
            const fieldErrors = data.error as Record<string, string[]>;
            if (fieldErrors.productCost || fieldErrors.quantity) {
              setQuoteErrors({
                productCost: fieldErrors.productCost?.[0],
                quantity: fieldErrors.quantity?.[0],
              });
              setQuoteResult(null);
            }
            if (fieldErrors._form) {
              setError(fieldErrors._form[0]);
            } else if (!fieldErrors.productCost && !fieldErrors.quantity) {
              setError(`Validation error (${res.status})`);
            }
          } else {
            setError(data?.error?._form?.[0] || `Server error (${res.status})`);
          }
          return;
        }
        const data = await res.json();
        if (token !== requestTokenRef.current) return;
        setPreview(data.preview);
        setQuoteResult(quoteIsValid ? (data.quote ?? null) : null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (token !== requestTokenRef.current) return;
        setError("Failed to connect to pricing preview API.");
      } finally {
        if (token === requestTokenRef.current) {
          setLoading(false);
          setRecalculating(false);
        }
      }
    },
    []
  );

  // Initial load
  useEffect(() => {
    fetchPreview([], quoteInputs, {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const debouncedRecalc = useCallback(
    (
      newEdits: Map<string, Edit>,
      quote: typeof quoteInputs,
      qErrors: QuoteFieldErrors
    ) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);

      // Skip POST if any margin edit is invalid
      if (!hasValidMargins(newEdits)) return;

      debounceRef.current = setTimeout(() => {
        fetchPreview(Array.from(newEdits.values()), quote, qErrors);
      }, DEBOUNCE_MS);
    },
    [fetchPreview]
  );

  const handleMarginChange = useCallback(
    (tier: string, lane: Lane, value: string) => {
      const num = parseFloat(value);
      const newEdits = new Map(edits);
      const newErrors = new Map(marginErrors);
      const key = `${tier}:${lane}`;

      if (value === "" || isNaN(num)) {
        newEdits.delete(key);
        newErrors.delete(key);
      } else {
        newEdits.set(key, { tier, lane, marginPercent: num });
        const err = validateMargin(num);
        if (err) {
          newErrors.set(key, err);
        } else {
          newErrors.delete(key);
        }
      }

      setEdits(newEdits);
      setMarginErrors(newErrors);

      if (newErrors.size > 0) {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        if (abortRef.current) {
          abortRef.current.abort();
          abortRef.current = null;
        }
        requestTokenRef.current += 1;
        setRecalculating(false);
        setQuoteResult(null);
        return;
      }

      const currentQuoteErrors = validateQuoteInputs(quoteInputs);
      debouncedRecalc(newEdits, quoteInputs, currentQuoteErrors);
    },
    [edits, marginErrors, quoteInputs, debouncedRecalc]
  );

  const handleResetCell = useCallback(
    (tier: string, lane: Lane) => {
      const key = `${tier}:${lane}`;
      const newEdits = new Map(edits);
      newEdits.delete(key);
      const newErrors = new Map(marginErrors);
      newErrors.delete(key);
      setEdits(newEdits);
      setMarginErrors(newErrors);
      if (selectedCell?.tier === tier && selectedCell?.lane === lane) {
        setSelectedCell(null);
      }
      const currentQuoteErrors = validateQuoteInputs(quoteInputs);
      debouncedRecalc(newEdits, quoteInputs, currentQuoteErrors);
    },
    [edits, marginErrors, quoteInputs, selectedCell, debouncedRecalc]
  );

  const handleResetAll = useCallback(() => {
    // Clear any pending debounced request
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // Abort any in-flight request so stale response can't repaint
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setEdits(new Map());
    setMarginErrors(new Map());
    setSelectedCell(null);
    const currentQuoteErrors = validateQuoteInputs(quoteInputs);
    fetchPreview([], quoteInputs, currentQuoteErrors);
  }, [quoteInputs, fetchPreview]);

  const handleQuoteChange = useCallback(
    (field: string, value: string) => {
      const newInputs = { ...quoteInputs, [field]: value };
      setQuoteInputs(newInputs);

      const newQuoteErrors = validateQuoteInputs(newInputs);
      setQuoteErrors(newQuoteErrors);

      // If quote has errors, clear the stale quote result
      if (newQuoteErrors.productCost || newQuoteErrors.quantity) {
        setQuoteResult(null);
      }

      debouncedRecalc(edits, newInputs, newQuoteErrors);
    },
    [quoteInputs, edits, debouncedRecalc]
  );

  const selectedTrace = useMemo(() => {
    if (!selectedCell || !preview) return null;
    const tier = preview.tiers.find((t) => t.tier === selectedCell.tier);
    if (!tier) return null;
    const key = `${selectedCell.tier}:${selectedCell.lane}`;
    const hasError = marginErrors.has(key);
    return {
      tier,
      laneData: tier.lanes[selectedCell.lane],
      lane: selectedCell.lane,
      hasError,
    };
  }, [selectedCell, preview, marginErrors]);

  if (loading && !preview) {
    return (
      <div className="space-y-4">
        <div className="h-24 rounded-lg bg-neutral-800/50 animate-pulse" />
        <div className="h-96 rounded-lg bg-neutral-800/50 animate-pulse" />
      </div>
    );
  }

  if (error && !preview) {
    return (
      <div className="rounded-lg border border-red-400/20 bg-red-400/5 p-6">
        <h2 className="text-lg font-semibold text-white font-display mb-2">
          Pricing Preview Unavailable
        </h2>
        <p className="text-sm text-neutral-400">{error}</p>
      </div>
    );
  }

  if (!preview) return null;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-4">
          <p className="text-sm text-amber-400">{error}</p>
        </div>
      )}

      <PricingContext
        policy={preview.pricingPolicy}
        dtf={preview.dtfContext}
        source={preview.source}
        schemaVersion={preview.schemaVersion}
      />

      <GridControls
        isDirty={isDirty}
        editCount={edits.size}
        recalculating={recalculating}
        onResetAll={handleResetAll}
      />

      <TierGrid
        tiers={preview.tiers}
        edits={edits}
        marginErrors={marginErrors}
        selectedCell={selectedCell}
        onMarginChange={handleMarginChange}
        onCellSelect={setSelectedCell}
        onResetCell={handleResetCell}
      />

      {selectedTrace && (
        <CalculationTrace
          tier={selectedTrace.tier}
          lane={selectedTrace.lane}
          data={selectedTrace.laneData}
          hasError={selectedTrace.hasError}
          onClose={() => setSelectedCell(null)}
        />
      )}

      <QuoteImpactPanel
        inputs={quoteInputs}
        result={quoteResult}
        errors={quoteErrors}
        onChange={handleQuoteChange}
        recalculating={recalculating}
      />

      <div className="rounded-lg border border-neutral-700/50 bg-neutral-800/50 p-4 text-center">
        <p className="text-xs text-neutral-400">
          Preview Only &mdash; This view does not affect Quote Desk pricing.
          Session edits are discarded on refresh.
        </p>
      </div>
    </div>
  );
}

function PricingContext({
  policy,
  dtf,
  source,
  schemaVersion,
}: {
  policy: PricingPolicy;
  dtf: DtfContext;
  source: string;
  schemaVersion: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-700/50 bg-neutral-800/50 p-5">
      <h2 className="text-sm font-semibold text-white font-display tracking-wide mb-4">
        Pricing Context
      </h2>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3">
        <CtxItem label="Contract Source" value={source.replace("lib/fixtures/", "")} />
        <CtxItem label="Schema Version" value={schemaVersion} />
        <CtxItem label="Product Multiplier" value={`${policy.productCostMultiplier}x`} />
        <CtxItem label="Commission Reserve" value={fmtPercent(policy.commissionReserveRate)} />
        <CtxItem label="Rounding Increment" value={fmtCurrency(policy.roundingIncrement)} />
        <CtxItem label="Production Mode" value={dtf.activeProductionMode} />
        <CtxItem label="Labor Policy" value={dtf.pricingMode} />
        <CtxItem label="Project Labor" value={fmtCurrency(dtf.sharedProjectLaborPerOrder)} />
        <CtxItem
          label="Transfer Size"
          value={`${dtf.capturedTransferSizeIn.width}" x ${dtf.capturedTransferSizeIn.height}"`}
        />
      </dl>
    </div>
  );
}

function CtxItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-neutral-400 mb-1">
        {label}
      </dt>
      <dd className="text-sm font-medium text-neutral-200">{value}</dd>
    </div>
  );
}

function GridControls({
  isDirty,
  editCount,
  recalculating,
  onResetAll,
}: {
  isDirty: boolean;
  editCount: number;
  recalculating: boolean;
  onResetAll: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold text-white font-display tracking-wide">
          DTF Tier-Margin Grid
        </h2>
        {recalculating && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-cyan-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            Recalculating
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {isDirty && (
          <span className="text-[11px] uppercase tracking-wider text-amber-400">
            {editCount} change{editCount !== 1 ? "s" : ""}
          </span>
        )}
        <button
          onClick={onResetAll}
          disabled={!isDirty}
          aria-label="Reset all margins"
          className="px-3 py-1.5 text-xs font-medium rounded border border-neutral-600 bg-neutral-700/50 text-neutral-300 transition-colors hover:border-neutral-500 hover:text-white disabled:text-neutral-600 disabled:cursor-not-allowed"
        >
          Reset All
        </button>
      </div>
    </div>
  );
}

function TierGrid({
  tiers,
  edits,
  marginErrors,
  selectedCell,
  onMarginChange,
  onCellSelect,
  onResetCell,
}: {
  tiers: TierData[];
  edits: Map<string, Edit>;
  marginErrors: MarginErrors;
  selectedCell: { tier: string; lane: Lane } | null;
  onMarginChange: (tier: string, lane: Lane, value: string) => void;
  onCellSelect: (cell: { tier: string; lane: Lane } | null) => void;
  onResetCell: (tier: string, lane: Lane) => void;
}) {
  return (
    <>
      {/* Desktop: horizontal table */}
      <div className="hidden lg:block rounded-lg border border-neutral-700/50 bg-neutral-800/50 overflow-x-auto">
        <table className="w-full text-xs" aria-label="DTF tier-margin grid">
          <thead>
            <tr className="border-b border-neutral-700/50">
              <th className="sticky left-0 bg-neutral-800 z-10 text-left px-3 py-2 text-neutral-400 uppercase tracking-wider font-medium whitespace-nowrap">
                Qty Tier
              </th>
              <th className="text-right px-3 py-2 text-neutral-400 uppercase tracking-wider font-medium">
                Min
              </th>
              <th className="text-right px-3 py-2 text-neutral-400 uppercase tracking-wider font-medium">
                Max
              </th>
              <th className="text-right px-3 py-2 text-neutral-400 uppercase tracking-wider font-medium whitespace-nowrap">
                Total COGS
              </th>
              <th className="text-right px-3 py-2 text-neutral-400 uppercase tracking-wider font-medium whitespace-nowrap">
                Base COGS
              </th>
              <th className="text-right px-3 py-2 text-neutral-400 uppercase tracking-wider font-medium whitespace-nowrap">
                Labor
              </th>
              {LANES.map((lane) => (
                <React.Fragment key={lane}>
                  <th className="text-center px-2 py-2 text-neutral-400 uppercase tracking-wider font-medium whitespace-nowrap border-l border-neutral-700/30">
                    {lane} Margin
                  </th>
                  <th className="text-right px-2 py-2 text-neutral-400 uppercase tracking-wider font-medium whitespace-nowrap">
                    {lane} Price
                  </th>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-700/30">
            {tiers.map((tier) => (
              <TierRow
                key={tier.tier}
                tier={tier}
                edits={edits}
                marginErrors={marginErrors}
                selectedCell={selectedCell}
                onMarginChange={onMarginChange}
                onCellSelect={onCellSelect}
                onResetCell={onResetCell}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: cards */}
      <div className="lg:hidden space-y-3">
        {tiers.map((tier) => (
          <MobileTierCard
            key={tier.tier}
            tier={tier}
            edits={edits}
            marginErrors={marginErrors}
            selectedCell={selectedCell}
            onMarginChange={onMarginChange}
            onCellSelect={onCellSelect}
            onResetCell={onResetCell}
          />
        ))}
      </div>
    </>
  );
}

function TierRow({
  tier,
  edits,
  marginErrors,
  selectedCell,
  onMarginChange,
  onCellSelect,
  onResetCell,
}: {
  tier: TierData;
  edits: Map<string, Edit>;
  marginErrors: MarginErrors;
  selectedCell: { tier: string; lane: Lane } | null;
  onMarginChange: (tier: string, lane: Lane, value: string) => void;
  onCellSelect: (cell: { tier: string; lane: Lane } | null) => void;
  onResetCell: (tier: string, lane: Lane) => void;
}) {
  return (
    <tr>
      <td className="sticky left-0 bg-neutral-800/90 z-10 px-3 py-2 text-neutral-200 font-medium whitespace-nowrap">
        {fmtQtyRange(tier.minQty, tier.maxQty)}
      </td>
      <td className="text-right px-3 py-2 text-neutral-400">{tier.minQty.toLocaleString()}</td>
      <td className="text-right px-3 py-2 text-neutral-400">
        {tier.maxQty >= 5000 ? "5,000" : tier.maxQty.toLocaleString()}
      </td>
      <td className="text-right px-3 py-2 text-neutral-400">
        {fmtCurrency(tier.activeTotalDtfCogs)}
      </td>
      <td className="text-right px-3 py-2 text-neutral-400">
        {fmtCurrency(tier.baseDtfCogs)}
      </td>
      <td className="text-right px-3 py-2 text-neutral-400">
        {fmtCurrency(tier.laborRecovery)}
      </td>
      {LANES.map((lane) => {
        const data = tier.lanes[lane];
        const key = `${tier.tier}:${lane}`;
        const edit = edits.get(key);
        const hasError = marginErrors.has(key);
        const isSelected =
          selectedCell?.tier === tier.tier && selectedCell?.lane === lane;
        const currentPrice = data.current.final;
        const draftPrice = data.draft.final;
        const priceChanged = currentPrice !== draftPrice;

        return (
          <React.Fragment key={lane}>
            <td className="border-l border-neutral-700/30 px-1 py-1">
              <MarginInput
                tier={tier.tier}
                lane={lane}
                currentMargin={data.currentMargin}
                edit={edit}
                hasError={hasError}
                errorMsg={marginErrors.get(key)}
                isSelected={isSelected}
                onMarginChange={onMarginChange}
                onSelect={() =>
                  onCellSelect(isSelected ? null : { tier: tier.tier, lane })
                }
                onReset={() => onResetCell(tier.tier, lane)}
              />
            </td>
            <td
              className={`text-right px-2 py-2 font-mono whitespace-nowrap ${
                hasError
                  ? "text-neutral-500"
                  : priceChanged
                    ? "text-cyan-400"
                    : "text-neutral-200"
              }`}
            >
              {hasError ? (
                <span aria-label={`${lane} price for tier ${tier.tier} unavailable`}>&mdash;</span>
              ) : (
                <>
                  {fmtCurrency(draftPrice)}
                  {priceChanged && (
                    <span className="block text-[10px] text-neutral-500 line-through">
                      {fmtCurrency(currentPrice)}
                    </span>
                  )}
                </>
              )}
            </td>
          </React.Fragment>
        );
      })}
    </tr>
  );
}

function MarginInput({
  tier,
  lane,
  currentMargin,
  edit,
  hasError,
  errorMsg,
  isSelected,
  onMarginChange,
  onSelect,
  onReset,
}: {
  tier: string;
  lane: Lane;
  currentMargin: string;
  edit: Edit | undefined;
  hasError: boolean;
  errorMsg?: string;
  isSelected: boolean;
  onMarginChange: (tier: string, lane: Lane, value: string) => void;
  onSelect: () => void;
  onReset: () => void;
}) {
  const currentPercent = Math.round(parseFloat(currentMargin) * 100);
  const displayValue = edit ? String(edit.marginPercent) : String(currentPercent);
  const isEdited = edit != null;
  const numVal = edit?.marginPercent ?? currentPercent;
  const warning = marginWarning(numVal);

  return (
    <div className="relative">
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={0}
          max={99}
          step={1}
          value={displayValue}
          onChange={(e) => onMarginChange(tier, lane, e.target.value)}
          onFocus={onSelect}
          aria-label={`${lane} margin for tier ${tier}`}
          aria-invalid={hasError || undefined}
          className={`w-14 px-1.5 py-1 text-xs text-right rounded border font-mono transition-colors ${
            hasError
              ? "border-red-400/50 bg-red-400/10 text-red-400"
              : isEdited
                ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-400"
                : isSelected
                  ? "border-neutral-500 bg-neutral-700 text-neutral-200"
                  : "border-neutral-600 bg-neutral-700/50 text-neutral-300"
          } focus:outline-none focus:ring-1 focus:ring-cyan-400/50`}
        />
        <span className="text-[10px] text-neutral-500">%</span>
        {isEdited && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReset();
            }}
            aria-label={`Reset ${lane} margin for tier ${tier}`}
            className="text-neutral-500 hover:text-neutral-300 text-[10px] leading-none"
            title="Reset"
          >
            &times;
          </button>
        )}
      </div>
      {isEdited && (
        <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-cyan-400" title="Changed" />
      )}
      {warning && isEdited && !hasError && (
        <span className="block text-[9px] text-amber-400 mt-0.5">{warning}</span>
      )}
      {hasError && (
        <span className="block text-[9px] text-red-400 mt-0.5" role="alert">
          {errorMsg ?? "0-99%"}
        </span>
      )}
    </div>
  );
}

function MobileTierCard({
  tier,
  edits,
  marginErrors,
  selectedCell,
  onMarginChange,
  onCellSelect,
  onResetCell,
}: {
  tier: TierData;
  edits: Map<string, Edit>;
  marginErrors: MarginErrors;
  selectedCell: { tier: string; lane: Lane } | null;
  onMarginChange: (tier: string, lane: Lane, value: string) => void;
  onCellSelect: (cell: { tier: string; lane: Lane } | null) => void;
  onResetCell: (tier: string, lane: Lane) => void;
}) {
  return (
    <div className="rounded-lg border border-neutral-700/50 bg-neutral-800/50 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white font-display">
          {fmtQtyRange(tier.minQty, tier.maxQty)}
        </h3>
        <div className="text-right">
          <span className="text-[11px] text-neutral-400 block">
            COGS {fmtCurrency(tier.activeTotalDtfCogs)}
          </span>
          <span className="text-[10px] text-neutral-500 block">
            Base {fmtCurrency(tier.baseDtfCogs)} + Labor {fmtCurrency(tier.laborRecovery)}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {LANES.map((lane) => {
          const data = tier.lanes[lane];
          const key = `${tier.tier}:${lane}`;
          const edit = edits.get(key);
          const hasError = marginErrors.has(key);
          const isSelected =
            selectedCell?.tier === tier.tier && selectedCell?.lane === lane;
          const priceChanged = data.current.final !== data.draft.final;

          return (
            <div key={lane} className="space-y-1">
              <div className="text-[11px] uppercase tracking-wider text-neutral-400">
                {lane}
              </div>
              <MarginInput
                tier={tier.tier}
                lane={lane}
                currentMargin={data.currentMargin}
                edit={edit}
                hasError={hasError}
                errorMsg={marginErrors.get(key)}
                isSelected={isSelected}
                onMarginChange={onMarginChange}
                onSelect={() =>
                  onCellSelect(isSelected ? null : { tier: tier.tier, lane })
                }
                onReset={() => onResetCell(tier.tier, lane)}
              />
              <div
                className={`text-sm font-mono ${
                  hasError
                    ? "text-neutral-500"
                    : priceChanged
                      ? "text-cyan-400"
                      : "text-neutral-200"
                }`}
              >
                {hasError ? (
                  <span>&mdash;</span>
                ) : (
                  <>
                    {fmtCurrency(data.draft.final)}
                    {priceChanged && (
                      <span className="text-[10px] text-neutral-500 line-through ml-1">
                        {fmtCurrency(data.current.final)}
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CalculationTrace({
  tier,
  lane,
  data,
  hasError,
  onClose,
}: {
  tier: TierData;
  lane: Lane;
  data: LaneData;
  hasError: boolean;
  onClose: () => void;
}) {
  const trace = data.draft;

  return (
    <div
      className="rounded-lg border border-neutral-700/50 bg-neutral-800/50 p-5"
      role="region"
      aria-label={`Calculation trace for ${lane} tier ${tier.tier}`}
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-white font-display tracking-wide">
          Calculation Trace &mdash; {lane} / {fmtQtyRange(tier.minQty, tier.maxQty)}
        </h3>
        <button
          onClick={onClose}
          aria-label="Close trace"
          className="text-neutral-400 hover:text-white text-sm"
        >
          &times;
        </button>
      </div>
      {hasError ? (
        <p className="text-sm text-neutral-500">
          Fix the margin value to see the calculation trace.
        </p>
      ) : (
        <dl className="space-y-2 text-sm">
          <TraceRow label="Base DTF COGS" value={fmtCurrency(trace.baseDtfCogs)} />
          <TraceRow
            label="At-Cost Labor Recovery"
            value={fmtCurrency(trace.laborRecovery)}
          />
          <TraceRow
            label="Target Gross Margin"
            value={fmtPercent(trace.targetMargin)}
            highlight={data.edited}
          />
          <TraceRow
            label="Margin-Loaded Amount"
            value={fmtCurrency(trace.marginLoadedAmount)}
          />
          <TraceRow label="Raw Calculated Price" value={fmtCurrency(trace.raw)} />
          <TraceRow label="Rounding Increment" value={fmtCurrency(trace.increment)} />
          <div className="border-t border-neutral-700/50 pt-2">
            <TraceRow
              label="Final Calculated Price"
              value={fmtCurrency(trace.final)}
              bold
            />
          </div>
          <TraceRow
            label="Achieved Margin After Rounding"
            value={fmtPercent(trace.achievedMargin)}
          />
          {data.edited && data.current.final !== data.draft.final && (
            <div className="border-t border-neutral-700/50 pt-2">
              <TraceRow
                label="Current Price"
                value={fmtCurrency(data.current.final)}
              />
              <TraceRow
                label="Price Delta"
                value={fmtDelta(
                  parseFloat(data.draft.final) - parseFloat(data.current.final)
                )}
                highlight
              />
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

function TraceRow({
  label,
  value,
  bold,
  highlight,
}: {
  label: string;
  value: string;
  bold?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex justify-between items-baseline">
      <dt className="text-neutral-400">{label}</dt>
      <dd
        className={`font-mono ${
          bold
            ? "text-white font-semibold text-base"
            : highlight
              ? "text-cyan-400"
              : "text-neutral-200"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function QuoteImpactPanel({
  inputs,
  result,
  errors,
  onChange,
  recalculating,
}: {
  inputs: { productCost: string; quantity: string; lane: Lane };
  result: QuoteResponse | null;
  errors: QuoteFieldErrors;
  onChange: (field: string, value: string) => void;
  recalculating: boolean;
}) {
  return (
    <div className="rounded-lg border border-neutral-700/50 bg-neutral-800/50 p-5">
      <h2 className="text-sm font-semibold text-white font-display tracking-wide mb-4">
        Quote Impact Preview
      </h2>

      <div className="grid grid-cols-3 gap-4 mb-5">
        <div>
          <label
            htmlFor="quote-product-cost"
            className="text-[11px] uppercase tracking-wider text-neutral-400 mb-1 block"
          >
            Product Cost
          </label>
          <input
            id="quote-product-cost"
            type="number"
            min={0}
            step={0.01}
            value={inputs.productCost}
            onChange={(e) => onChange("productCost", e.target.value)}
            aria-label="Quote product cost"
            aria-invalid={!!errors.productCost || undefined}
            className={`w-full px-2 py-1.5 text-xs rounded border ${
              errors.productCost
                ? "border-red-400/50 bg-red-400/10 text-red-400"
                : "border-neutral-600 bg-neutral-700/50 text-neutral-200"
            } font-mono focus:outline-none focus:ring-1 focus:ring-cyan-400/50`}
          />
          {errors.productCost && (
            <span className="block text-[9px] text-red-400 mt-0.5" role="alert">
              {errors.productCost}
            </span>
          )}
        </div>
        <div>
          <label
            htmlFor="quote-quantity"
            className="text-[11px] uppercase tracking-wider text-neutral-400 mb-1 block"
          >
            Quantity
          </label>
          <input
            id="quote-quantity"
            type="number"
            min={1}
            max={5000}
            step={1}
            value={inputs.quantity}
            onChange={(e) => onChange("quantity", e.target.value)}
            aria-label="Quote quantity"
            aria-invalid={!!errors.quantity || undefined}
            className={`w-full px-2 py-1.5 text-xs rounded border ${
              errors.quantity
                ? "border-red-400/50 bg-red-400/10 text-red-400"
                : "border-neutral-600 bg-neutral-700/50 text-neutral-200"
            } font-mono focus:outline-none focus:ring-1 focus:ring-cyan-400/50`}
          />
          {errors.quantity && (
            <span className="block text-[9px] text-red-400 mt-0.5" role="alert">
              {errors.quantity}
            </span>
          )}
        </div>
        <div>
          <label
            htmlFor="quote-lane"
            className="text-[11px] uppercase tracking-wider text-neutral-400 mb-1 block"
          >
            Margin Lane
          </label>
          <select
            id="quote-lane"
            value={inputs.lane}
            onChange={(e) => onChange("lane", e.target.value)}
            aria-label="Quote margin lane"
            className="w-full px-2 py-1.5 text-xs rounded border border-neutral-600 bg-neutral-700/50 text-neutral-200 focus:outline-none focus:ring-1 focus:ring-cyan-400/50"
          >
            {LANES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>

      {recalculating && !result && (
        <div className="h-20 rounded bg-neutral-700/30 animate-pulse" />
      )}

      {result && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <h3 className="text-[11px] uppercase tracking-wider text-neutral-400 mb-2">
                Current
              </h3>
              <dl className="space-y-1.5 text-sm">
                <QuoteLine label="Product Sell" value={fmtCurrency(result.current.productSell)} />
                <QuoteLine label="Decoration Sell" value={fmtCurrency(result.current.decorationSell)} />
                <QuoteLine label="Unit Price" value={fmtCurrency(result.current.unitPrice)} bold />
                <QuoteLine label="Order Total" value={fmtCurrency(result.current.orderTotal)} />
                <QuoteLine label="Commission / Item" value={fmtCurrency(result.current.commissionReserve)} />
              </dl>
            </div>
            <div>
              <h3 className="text-[11px] uppercase tracking-wider text-neutral-400 mb-2">
                Draft
              </h3>
              <dl className="space-y-1.5 text-sm">
                <QuoteLine label="Product Sell" value={fmtCurrency(result.draft.productSell)} />
                <QuoteLine
                  label="Decoration Sell"
                  value={fmtCurrency(result.draft.decorationSell)}
                  delta={result.delta.decorationSell}
                />
                <QuoteLine
                  label="Unit Price"
                  value={fmtCurrency(result.draft.unitPrice)}
                  delta={result.delta.unitPrice}
                  bold
                />
                <QuoteLine
                  label="Order Total"
                  value={fmtCurrency(result.draft.orderTotal)}
                  delta={result.delta.orderTotal}
                />
                <QuoteLine
                  label="Commission / Item"
                  value={fmtCurrency(result.draft.commissionReserve)}
                  delta={result.delta.commissionReserve}
                />
              </dl>
              {result.delta.orderTotal !== "0.00" && (
                <div className="mt-3 pt-2 border-t border-neutral-700/30">
                  <span className="text-xs text-cyan-400">
                    Order delta: {fmtDelta(result.delta.orderTotal)} ({fmtDeltaPercent(result.delta.orderPercent)})
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Contribution Comparison */}
          <div className="border-t border-neutral-700/50 pt-4">
            <h3 className="text-[11px] uppercase tracking-wider text-neutral-400 mb-3">
              Contribution Comparison
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <h4 className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">
                  Current
                </h4>
                <dl className="space-y-1.5 text-sm">
                  <QuoteLine label="Gross Profit / Item" value={fmtCurrency(result.current.grossProfitBeforeCommission)} />
                  <QuoteLine label="Net Contribution / Item" value={fmtCurrency(result.current.netContributionAfterCommission)} />
                  <QuoteLine label="Contribution Margin" value={fmtPercent(result.current.contributionMarginAfterCommission)} />
                  <QuoteLine label="Net Contribution / Order" value={fmtCurrency(result.current.netContributionOrderTotal)} bold />
                </dl>
              </div>
              <div>
                <h4 className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">
                  Draft
                </h4>
                <dl className="space-y-1.5 text-sm">
                  <QuoteLine
                    label="Gross Profit / Item"
                    value={fmtCurrency(result.draft.grossProfitBeforeCommission)}
                    delta={result.delta.grossProfitBeforeCommission}
                  />
                  <QuoteLine
                    label="Net Contribution / Item"
                    value={fmtCurrency(result.draft.netContributionAfterCommission)}
                    delta={result.delta.netContributionAfterCommission}
                  />
                  <QuoteLine
                    label="Contribution Margin"
                    value={fmtPercent(result.draft.contributionMarginAfterCommission)}
                    delta={result.delta.contributionMarginAfterCommission}
                    deltaIsPercent
                  />
                  <QuoteLine
                    label="Net Contribution / Order"
                    value={fmtCurrency(result.draft.netContributionOrderTotal)}
                    delta={result.delta.netContributionOrderTotal}
                    bold
                  />
                </dl>
              </div>
              <div>
                <h4 className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">
                  Delta
                </h4>
                <dl className="space-y-1.5 text-sm">
                  <QuoteLine label="Gross Profit / Item" value={fmtDelta(result.delta.grossProfitBeforeCommission)} />
                  <QuoteLine label="Net Contribution / Item" value={fmtDelta(result.delta.netContributionAfterCommission)} />
                  <QuoteLine label="Contribution Margin" value={fmtDeltaPercent(result.delta.contributionMarginAfterCommission)} />
                  <QuoteLine label="Net Contribution / Order" value={fmtDelta(result.delta.netContributionOrderTotal)} bold />
                </dl>
              </div>
            </div>
            <p className="text-[10px] text-neutral-500 mt-2">
              Commission is per item. Net contribution = gross profit minus commission per item.
            </p>
          </div>
        </div>
      )}

      {!result && !recalculating && (
        <p className="text-sm text-neutral-400">
          Enter valid quote parameters to see impact comparison.
        </p>
      )}
    </div>
  );
}

function QuoteLine({
  label,
  value,
  delta,
  bold,
  deltaIsPercent,
}: {
  label: string;
  value: string;
  delta?: string;
  bold?: boolean;
  deltaIsPercent?: boolean;
}) {
  const deltaNum = delta ? parseFloat(delta) : 0;
  const hasDelta = delta && deltaNum !== 0;

  return (
    <div className="flex justify-between items-baseline">
      <dt className="text-neutral-400">{label}</dt>
      <dd className="flex items-baseline gap-2">
        <span
          className={`font-mono ${bold ? "text-white font-semibold" : "text-neutral-200"}`}
        >
          {value}
        </span>
        {hasDelta && (
          <span
            className={`text-[10px] font-mono ${
              deltaNum > 0 ? "text-amber-400" : "text-green-400"
            }`}
          >
            {deltaIsPercent ? fmtDeltaPercent(deltaNum) : fmtDelta(deltaNum)}
          </span>
        )}
      </dd>
    </div>
  );
}
