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

function PrimaryRow({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta?: string | null;
}) {
  const deltaNum = delta == null ? 0 : parseFloat(delta);
  const hasDelta = delta != null && Number.isFinite(deltaNum) && deltaNum !== 0;

  return (
    <div className="flex justify-between items-baseline py-1.5">
      <dt className="text-neutral-400 text-xs">{label}</dt>
      <dd className="flex items-baseline gap-2">
        <span className="font-mono text-white font-bold text-base sm:text-lg">
          {value}
        </span>
        {hasDelta && (
          <span
            className={`text-[10px] font-mono ${
              deltaNum > 0 ? "text-amber-400" : "text-green-400"
            }`}
          >
            {fmtDelta(delta as string)}
          </span>
        )}
      </dd>
    </div>
  );
}

function OutcomeStat({
  label,
  value,
  delta,
  deltaIsPercent,
}: {
  label: string;
  value: string;
  delta?: string | null;
  deltaIsPercent?: boolean;
}) {
  const deltaNum = delta == null ? 0 : parseFloat(delta);
  const hasDelta = delta != null && Number.isFinite(deltaNum) && deltaNum !== 0;

  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[9.5px] uppercase tracking-wide text-neutral-500 font-semibold">
        {label}
      </dt>
      <dd className="flex items-baseline gap-1.5">
        <span className="font-mono text-neutral-200 font-semibold text-xs">
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
    `w-full px-3 text-sm rounded-md border font-mono min-h-[44px] focus:outline-none focus:ring-1 focus:ring-cyan-400/50 ${
      invalid
        ? "border-red-400/50 bg-red-400/10 text-red-300"
        : "border-neutral-700 bg-neutral-900/60 text-neutral-200"
    }`;

  const deltaNum =
    result?.available && result.delta ? parseFloat(result.delta.orderTotal) : 0;
  const hasOrderDelta =
    !!result?.available && !!result.delta && Number.isFinite(deltaNum) && deltaNum !== 0;

  return (
    <section
      aria-labelledby="dtf-quote-impact-heading"
      className="rounded-lg border border-neutral-800 bg-neutral-950 overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-5 py-3 border-b border-neutral-800 bg-neutral-900/60">
        <h3
          id="dtf-quote-impact-heading"
          className="text-sm font-semibold text-white tracking-wide"
        >
          Quote Impact Preview
        </h3>
        <span className="text-[11.5px] text-neutral-500">
          {recalculating ? (
            <span
              className="inline-flex items-center gap-1.5 text-cyan-400"
              role="status"
            >
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
              Recalculating
            </span>
          ) : (
            "Recalculates live · prototype only"
          )}
        </span>
      </div>

      <div className="p-4 sm:p-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-[18px] pb-4 border-b border-neutral-800/70">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="dtf-quote-product-cost"
              className="text-[10px] uppercase tracking-wider text-neutral-400 font-semibold"
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
              <span className="block text-[10px] text-red-400" role="alert">
                {errors.productCost}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="dtf-quote-quantity"
              className="text-[10px] uppercase tracking-wider text-neutral-400 font-semibold"
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
              <span className="block text-[10px] text-red-400" role="alert">
                {errors.quantity}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="dtf-quote-lane"
              className="text-[10px] uppercase tracking-wider text-neutral-400 font-semibold"
            >
              Pricing Lane
            </label>
            <select
              id="dtf-quote-lane"
              value={inputs.lane}
              onChange={(e) => onChange("lane", e.target.value)}
              className="w-full px-3 text-sm rounded-md border border-neutral-700 bg-neutral-900/60 text-neutral-200 min-h-[44px] focus:outline-none focus:ring-1 focus:ring-cyan-400/50"
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
          <div className="h-20 rounded bg-neutral-900/60 animate-pulse" />
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
            {result.currentUnavailableReason && (
              <p className="text-[11px] text-amber-300">
                {result.currentUnavailableReason}
              </p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="rounded-md border border-neutral-800 bg-neutral-900/60 px-4 py-3.5">
                <h4 className="text-[11px] uppercase tracking-wider text-neutral-400 font-semibold mb-2.5">
                  Saved
                </h4>
                {result.current ? (
                  <dl className="space-y-0.5">
                    <PrimaryRow
                      label="Unit Price"
                      value={fmtCurrency(result.current.unitPrice)}
                    />
                    <PrimaryRow
                      label="Order Total"
                      value={fmtCurrency(result.current.orderTotal)}
                    />
                  </dl>
                ) : (
                  <p className="text-neutral-500 text-xs">
                    No comparable saved price.
                  </p>
                )}
              </div>
              <div className="rounded-md border border-neutral-800 bg-neutral-900/60 px-4 py-3.5">
                <h4 className="text-[11px] uppercase tracking-wider text-neutral-400 font-semibold mb-2.5">
                  Draft
                </h4>
                <dl className="space-y-0.5">
                  <PrimaryRow
                    label="Unit Price"
                    value={fmtCurrency(result.draft.unitPrice)}
                    delta={result.delta?.unitPrice}
                  />
                  <PrimaryRow
                    label="Order Total"
                    value={fmtCurrency(result.draft.orderTotal)}
                    delta={result.delta?.orderTotal}
                  />
                </dl>
              </div>
            </div>

            <div className="rounded-md border border-neutral-800 bg-neutral-900/60 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
              <span className="text-[11px] uppercase tracking-wider text-neutral-500 font-semibold">
                Order Total Δ
              </span>
              <span
                className={`text-lg font-bold font-mono ${
                  hasOrderDelta
                    ? deltaNum > 0
                      ? "text-amber-400"
                      : "text-green-400"
                    : "text-neutral-400"
                }`}
              >
                {result.delta
                  ? `Order delta: ${fmtDelta(result.delta.orderTotal)} (${fmtDeltaPercent(
                      result.delta.orderPercent
                    )})`
                  : "No change"}
              </span>
            </div>

            <div className="border-t border-neutral-800 pt-4">
              <h4 className="text-[11px] uppercase tracking-wider text-neutral-500 mb-3">
                Contribution Outcome
              </h4>
              <dl className="flex flex-wrap gap-x-6 gap-y-3">
                <OutcomeStat
                  label="Gross Profit / Item"
                  value={fmtCurrency(result.draft.grossProfitBeforeCommission)}
                  delta={result.delta?.grossProfitBeforeCommission}
                />
                <OutcomeStat
                  label="Commission Reserve / Item"
                  value={fmtCurrency(result.draft.commissionReserve)}
                  delta={result.delta?.commissionReserve}
                />
                <OutcomeStat
                  label="Net Contribution / Item"
                  value={fmtCurrency(result.draft.netContributionAfterCommission)}
                  delta={result.delta?.netContributionAfterCommission}
                />
                <OutcomeStat
                  label="Post-Commission Contribution Margin"
                  value={fmtPercent(
                    result.draft.contributionMarginAfterCommission
                  )}
                  delta={result.delta?.contributionMarginAfterCommission}
                  deltaIsPercent
                />
                <OutcomeStat
                  label="Net Contribution / Order"
                  value={fmtCurrency(result.draft.netContributionOrderTotal)}
                  delta={result.delta?.netContributionOrderTotal}
                />
              </dl>
            </div>

            <p className="text-[10px] text-neutral-500">
              Tier <span className="text-neutral-300">{result.draft.tier}</span> ·
              cost basis {result.costBasis.basis} ·{" "}
              {result.costBasis.source === "contract"
                ? "captured contract tier"
                : "production COGS engine"}{" "}
              · modeled decoration COGS{" "}
              {fmtCurrency(result.draft.modeledDecorationCogs)} · product sell{" "}
              {fmtCurrency(result.draft.productSell)} (2× product cost)
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
