"use client";

import React from "react";
import type { DtfQuoteImpact } from "@/lib/pricing/dtf-matrix-preview-types";
import {
  fmtCurrency,
  fmtDelta,
  fmtDeltaPercent,
  fmtPercent,
} from "../pricing-helpers";

export type QuoteInputs = {
  productCost: string;
  quantity: string;
  lane: string;
};

export type QuoteFieldErrors = {
  productCost?: string;
  quantity?: string;
};

type Props = {
  inputs: QuoteInputs;
  errors: QuoteFieldErrors;
  lanes: Array<{ key: string; label: string }>;
  result: DtfQuoteImpact | null;
  recalculating: boolean;
  maxQuantity: number;
  maxProductCost: number;
  onChange: (field: keyof QuoteInputs, value: string) => void;
};

function Line({
  label,
  value,
  delta,
  deltaIsPercent,
  bold,
}: {
  label: string;
  value: string;
  delta?: string | null;
  deltaIsPercent?: boolean;
  bold?: boolean;
}) {
  const deltaNum = delta == null ? 0 : parseFloat(delta);
  const hasDelta = delta != null && Number.isFinite(deltaNum) && deltaNum !== 0;

  return (
    <div className="flex justify-between items-baseline gap-3">
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

/**
 * Saved configuration versus unsaved draft, for one representative quote.
 *
 * The comparison always reads the draft tier/lane's own direct price, so it
 * reacts identically whether the admin edited the price or the DTF GM%
 * (a GM% edit is stored as the resulting price).
 *
 * Post-commission contribution is shown as an outcome only — it is never the
 * price target, and the 8% reserve is never folded into the lane margin.
 */
export default function DtfQuoteImpact({
  inputs,
  errors,
  lanes,
  result,
  recalculating,
  maxQuantity,
  maxProductCost,
  onChange,
}: Props) {
  const inputClass = (invalid?: string) =>
    `w-full px-2 py-1.5 text-xs rounded border font-mono min-h-[36px] focus:outline-none focus:ring-1 focus:ring-cyan-400/50 ${
      invalid
        ? "border-red-400/50 bg-red-400/10 text-red-300"
        : "border-neutral-600 bg-neutral-700/50 text-neutral-200"
    }`;

  return (
    <section
      aria-labelledby="dtf-quote-impact-heading"
      className="rounded-lg border border-neutral-700/50 bg-neutral-800/50 p-4 sm:p-5"
    >
      <div className="flex items-center gap-3 mb-4">
        <h3
          id="dtf-quote-impact-heading"
          className="text-sm font-semibold text-white tracking-wide"
        >
          Quote Impact Preview
        </h3>
        {recalculating && (
          <span
            className="inline-flex items-center gap-1.5 text-[11px] text-cyan-400"
            role="status"
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            Recalculating
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <div>
          <label
            htmlFor="dtf-quote-product-cost"
            className="text-[11px] uppercase tracking-wider text-neutral-400 mb-1 block"
          >
            Product Cost
          </label>
          <input
            id="dtf-quote-product-cost"
            type="number"
            inputMode="decimal"
            min={0}
            max={maxProductCost}
            step={0.01}
            value={inputs.productCost}
            onChange={(e) => onChange("productCost", e.target.value)}
            aria-invalid={errors.productCost ? true : undefined}
            className={inputClass(errors.productCost)}
          />
          {errors.productCost && (
            <span className="block text-[10px] text-red-400 mt-0.5" role="alert">
              {errors.productCost}
            </span>
          )}
        </div>
        <div>
          <label
            htmlFor="dtf-quote-quantity"
            className="text-[11px] uppercase tracking-wider text-neutral-400 mb-1 block"
          >
            Quantity
          </label>
          <input
            id="dtf-quote-quantity"
            type="number"
            inputMode="numeric"
            min={1}
            max={maxQuantity}
            step={1}
            value={inputs.quantity}
            onChange={(e) => onChange("quantity", e.target.value)}
            aria-invalid={errors.quantity ? true : undefined}
            className={inputClass(errors.quantity)}
          />
          {errors.quantity && (
            <span className="block text-[10px] text-red-400 mt-0.5" role="alert">
              {errors.quantity}
            </span>
          )}
        </div>
        <div>
          <label
            htmlFor="dtf-quote-lane"
            className="text-[11px] uppercase tracking-wider text-neutral-400 mb-1 block"
          >
            Pricing Lane
          </label>
          <select
            id="dtf-quote-lane"
            value={inputs.lane}
            onChange={(e) => onChange("lane", e.target.value)}
            className="w-full px-2 py-1.5 text-xs rounded border border-neutral-600 bg-neutral-700/50 text-neutral-200 min-h-[36px] focus:outline-none focus:ring-1 focus:ring-cyan-400/50"
          >
            {lanes.map((lane) => (
              <option key={lane.key} value={lane.key}>
                {lane.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!result && recalculating && (
        <div className="h-20 rounded bg-neutral-700/30 animate-pulse" />
      )}

      {!result && !recalculating && (
        <p className="text-xs text-neutral-400">
          Enter a product cost, quantity, and lane to compare the saved
          configuration against your unsaved draft.
        </p>
      )}

      {result && !result.available && (
        <p className="text-xs text-amber-300" role="alert">
          {result.message}
        </p>
      )}

      {result && result.available && (
        <div className="space-y-4" data-testid="dtf-quote-impact-result">
          <p className="text-[10px] text-neutral-500">
            Tier <span className="text-neutral-300">{result.draft.tier}</span> ·
            cost basis {result.costBasis.basis} ·{" "}
            {result.costBasis.source === "contract"
              ? "captured contract tier"
              : "production COGS engine"}
          </p>

          {result.currentUnavailableReason && (
            <p className="text-[11px] text-amber-300">
              {result.currentUnavailableReason}
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <h4 className="text-[11px] uppercase tracking-wider text-neutral-400 mb-2">
                Saved
              </h4>
              <dl className="space-y-1.5 text-xs sm:text-sm">
                {result.current ? (
                  <>
                    <Line
                      label="Product Sell"
                      value={fmtCurrency(result.current.productSell)}
                    />
                    <Line
                      label="Decoration Sell"
                      value={fmtCurrency(result.current.decorationSell)}
                    />
                    <Line
                      label="Unit Price"
                      value={fmtCurrency(result.current.unitPrice)}
                      bold
                    />
                    <Line
                      label="Order Total"
                      value={fmtCurrency(result.current.orderTotal)}
                    />
                    <Line
                      label="Commission Reserve / Item"
                      value={fmtCurrency(result.current.commissionReserve)}
                    />
                  </>
                ) : (
                  <p className="text-neutral-500 text-xs">
                    No comparable saved price.
                  </p>
                )}
              </dl>
            </div>
            <div>
              <h4 className="text-[11px] uppercase tracking-wider text-neutral-400 mb-2">
                Draft
              </h4>
              <dl className="space-y-1.5 text-xs sm:text-sm">
                <Line
                  label="Product Sell"
                  value={fmtCurrency(result.draft.productSell)}
                  delta={result.delta?.productSell}
                />
                <Line
                  label="Decoration Sell"
                  value={fmtCurrency(result.draft.decorationSell)}
                  delta={result.delta?.decorationSell}
                />
                <Line
                  label="Unit Price"
                  value={fmtCurrency(result.draft.unitPrice)}
                  delta={result.delta?.unitPrice}
                  bold
                />
                <Line
                  label="Order Total"
                  value={fmtCurrency(result.draft.orderTotal)}
                  delta={result.delta?.orderTotal}
                />
                <Line
                  label="Commission Reserve / Item"
                  value={fmtCurrency(result.draft.commissionReserve)}
                  delta={result.delta?.commissionReserve}
                />
              </dl>
              {result.delta && result.delta.orderTotal !== "0.00" && (
                <div className="mt-3 pt-2 border-t border-neutral-700/30">
                  <span className="text-xs text-cyan-400">
                    Order delta: {fmtDelta(result.delta.orderTotal)} (
                    {fmtDeltaPercent(result.delta.orderPercent)})
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-neutral-700/50 pt-4">
            <h4 className="text-[11px] uppercase tracking-wider text-neutral-400 mb-3">
              Contribution Outcome
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <dl className="space-y-1.5 text-xs sm:text-sm">
                <Line
                  label="Gross Profit / Item"
                  value={fmtCurrency(result.draft.grossProfitBeforeCommission)}
                  delta={result.delta?.grossProfitBeforeCommission}
                />
                <Line
                  label="Net Contribution / Item"
                  value={fmtCurrency(result.draft.netContributionAfterCommission)}
                  delta={result.delta?.netContributionAfterCommission}
                />
              </dl>
              <dl className="space-y-1.5 text-xs sm:text-sm">
                <Line
                  label="Post-Commission Contribution Margin"
                  value={fmtPercent(
                    result.draft.contributionMarginAfterCommission
                  )}
                  delta={result.delta?.contributionMarginAfterCommission}
                  deltaIsPercent
                />
                <Line
                  label="Net Contribution / Order"
                  value={fmtCurrency(result.draft.netContributionOrderTotal)}
                  delta={result.delta?.netContributionOrderTotal}
                  bold
                />
              </dl>
            </div>
            <p className="text-[10px] text-neutral-500 mt-3">
              {result.contributionBasis}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
