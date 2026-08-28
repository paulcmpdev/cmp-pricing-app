"use client";

import React, { useState } from "react";
import {
  marginFromPrice,
  priceFromMargin,
  type DtfCostBasis,
} from "@/lib/pricing/dtf-margin-math";
import { fmtCurrency } from "../pricing-helpers";

export type Driver = "price" | "margin";

export type CellInputError = { rawText: string; label: string; message: string };

type Props = {
  /**
   * Stable parent-side identity for this cell: row identity + quantity span +
   * lane key. It is what the editor keys its cell-error registry by, and it is
   * also this cell's reset trigger — when the row it renders becomes a
   * different row (tier deleted, span re-typed), the typed GM% buffer and any
   * error it produced belong to the old row and must not survive.
   */
  cellKey: string;
  tierLabel: string;
  laneKey: string;
  laneLabel: string;
  price: number | undefined;
  /**
   * Server-resolved cost basis for this tier's quantity span. Null until the
   * first preview response lands (or while a brand-new span has no basis
   * yet) — DTF GM% is unknowable without it, so the field degrades to a
   * disabled, clearly-labelled placeholder instead of guessing.
   */
  basis: DtfCostBasis | null;
  roundingIncrement: string;
  editing: boolean;
  disabled: boolean;
  persistedError?: CellInputError;
  onPriceChange: (price: number) => void;
  /**
   * Reports this cell's typed-GM% input error to the editor so Save can refuse
   * a draft whose visible price is stale relative to what the admin typed.
   * Called with null only for a valid correction. The parent owns persistence
   * and structural pruning, so unmount is not a validity event.
   */
  onValidityChange: (cellKey: string, error: CellInputError | null) => void;
};

function formatPercent(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return `${n.toFixed(1)}%`;
}

// Collapses binary floating-point noise (e.g. 6.550000000000001, produced by
// $0.05-increment rounding upstream) back to the clean decimal an admin
// actually expects to see, without forcing a fixed decimal count that would
// rewrite whole-dollar prices like 6 into 6.00.
function cleanPrice(value: number): number {
  return Number(value.toFixed(10));
}

/**
 * One tier/lane cell: direct price (primary) paired with its DTF gross
 * margin (compact secondary).
 *
 * The persisted value is always the direct price. Editing DTF GM% converts
 * to a price immediately via the approved formula — margin-load base COGS
 * only, add shared project labor at cost, round UP to the configured $0.05
 * increment — so downstream consumers (validation, save, Quote Impact) never
 * have to care which field the admin typed into.
 *
 * Because rounding up lands at or above the requested margin, the GM% field
 * keeps the admin's typed text while they are working and snaps to the
 * actually-achieved margin on blur.
 */
export default function DtfPriceCell({
  cellKey,
  tierLabel,
  laneKey,
  laneLabel,
  price,
  basis,
  roundingIncrement,
  editing,
  disabled,
  persistedError,
  onPriceChange,
  onValidityChange,
}: Props) {
  // Non-null only while the admin is actively typing a direct price.
  const [priceText, setPriceText] = useState<string | null>(null);
  // Non-null only while the admin is actively typing a GM%.
  const [marginText, setMarginText] = useState<string | null>(null);
  const [driver, setDriver] = useState<Driver | null>(null);
  // The price this cell last produced from a GM% edit. If `price` arrives
  // different from it, the change came from somewhere else (direct price
  // edit, cancel, reload) and the typed GM% buffer is stale.
  const [emittedPrice, setEmittedPrice] = useState<number | null>(null);

  // Rows are rendered by index, so one mounted cell can be handed a different
  // row (or flipped out of edit mode by Cancel) without ever unmounting. Treat
  // either as a full reset, so a stale typed GM% can never keep Save disabled
  // for a row that no longer exists.
  const identity = `${cellKey}|${editing ? "edit" : "view"}`;
  const [lastIdentity, setLastIdentity] = useState(identity);
  if (lastIdentity !== identity) {
    setLastIdentity(identity);
    setPriceText(null);
    setMarginText(null);
    setEmittedPrice(null);
    setDriver(null);
  }

  if (marginText !== null && emittedPrice !== null && price !== emittedPrice) {
    setMarginText(null);
    setEmittedPrice(null);
  }

  const errorLabel = `Tier ${tierLabel} · ${laneLabel}`;
  const marginError = persistedError?.message ?? null;

  const derived =
    basis && price != null ? marginFromPrice(basis, price) : null;

  const derivedPercent = derived?.ok ? derived.marginPercent : null;
  const derivedError = derived && !derived.ok ? derived.message : null;
  const belowCost = derived?.ok ? derived.belowCost : false;

  const marginFieldValue =
    persistedError?.rawText ??
    marginText ??
    (derivedPercent === null ? "" : Number(derivedPercent).toFixed(1));

  const priceFieldValue =
    priceText ?? (price == null ? "" : String(cleanPrice(price)));

  const priceLabel = `Tier ${tierLabel} ${laneLabel} price`;
  const marginLabel = `Tier ${tierLabel} ${laneLabel} DTF GM percent`;
  const describedBy = `dtf-cell-note-${tierLabel}-${laneKey}`.replace(/\s+/g, "_");

  function handlePriceInput(raw: string) {
    if (disabled) return;
    const num = parseFloat(raw);
    setPriceText(raw);
    setMarginText(null);
    onValidityChange(cellKey, null);
    setEmittedPrice(null);
    setDriver("price");
    onPriceChange(Number.isFinite(num) ? num : 0);
  }

  function handlePriceBlur() {
    // Snap back to the clean, noise-free rendering of the persisted price.
    setPriceText(null);
  }

  function handleMarginInput(raw: string) {
    if (disabled) return;
    setPriceText(null);
    setMarginText(raw);
    setDriver("margin");

    if (raw.trim() === "") {
      onValidityChange(cellKey, null);
      return;
    }

    const percent = parseFloat(raw);
    if (!Number.isFinite(percent)) {
      onValidityChange(cellKey, {
        rawText: raw,
        label: errorLabel,
        message: "Enter a number.",
      });
      return;
    }
    if (!basis) {
      onValidityChange(cellKey, {
        rawText: raw,
        label: errorLabel,
        message: "Cost basis unavailable for this tier.",
      });
      return;
    }

    const result = priceFromMargin(basis, percent / 100, roundingIncrement);
    if (!result.ok) {
      onValidityChange(cellKey, {
        rawText: raw,
        label: errorLabel,
        message: result.message,
      });
      return;
    }

    onValidityChange(cellKey, null);
    const next = Number(result.final);
    setEmittedPrice(next);
    onPriceChange(next);
  }

  function handleMarginBlur() {
    // An invalid GM% must survive leaving the field. The price on screen is
    // whatever the last *accepted* input produced, so discarding the typed
    // text here would hide the mismatch and hand Save a draft the admin never
    // asked for. The value stays visible, the error stays published, and Save
    // stays blocked until it is corrected, cancelled, or the row goes away.
    if (marginError) return;

    // Snap back to the margin actually achieved after rounding up.
    setMarginText(null);
    setEmittedPrice(null);
  }

  if (!editing) {
    return (
      <div className="flex flex-col items-end leading-tight">
        <span className="font-mono text-neutral-200">
          {price == null ? "--" : fmtCurrency(price)}
        </span>
        <span
          className={`text-[10px] font-mono ${
            derivedError || belowCost ? "text-red-400" : "text-neutral-500"
          }`}
          title={derivedError ?? undefined}
        >
          {derivedError
            ? "GM n/a"
            : derivedPercent === null
              ? "GM --"
              : `GM ${formatPercent(derivedPercent)}`}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-stretch gap-1 min-w-[104px]">
      <div className="flex items-center gap-1 justify-end">
        <span className="text-[9px] uppercase tracking-wider text-neutral-500 shrink-0">
          $
        </span>
        <input
          type="number"
          value={priceFieldValue}
          onChange={(e) => handlePriceInput(e.target.value)}
          onBlur={handlePriceBlur}
          step={roundingIncrement}
          min="0"
          disabled={disabled}
          aria-label={priceLabel}
          aria-describedby={describedBy}
          className="w-[68px] text-xs text-right bg-neutral-800 border border-neutral-600 rounded px-1.5 py-1 text-neutral-200 min-h-[32px] focus:outline-none focus:ring-1 focus:ring-cyan-400/60"
        />
      </div>
      <div className="flex items-center gap-1 justify-end">
        <input
          type="number"
          value={marginFieldValue}
          onChange={(e) => handleMarginInput(e.target.value)}
          onBlur={handleMarginBlur}
          step="0.1"
          min="0"
          max="99.9"
          disabled={disabled || !basis}
          aria-label={marginLabel}
          aria-describedby={describedBy}
          aria-invalid={marginError ? true : undefined}
          title={!basis ? "Cost basis not resolved yet for this tier." : undefined}
          className={`w-[62px] text-[11px] text-right bg-neutral-800/70 border rounded px-1.5 py-1 min-h-[32px] focus:outline-none focus:ring-1 focus:ring-cyan-400/60 disabled:opacity-40 ${
            marginError || derivedError || belowCost
              ? "border-red-500/60 text-red-300"
              : "border-neutral-700 text-neutral-300"
          }`}
        />
        <span className="text-[9px] uppercase tracking-wider text-neutral-500 shrink-0 w-[12px]">
          %
        </span>
      </div>
      <span id={describedBy} className="sr-only">
        {`Direct price and DTF gross margin for tier ${tierLabel}, lane ${laneLabel}. Editing either field recalculates the other.`}
      </span>
      {(marginError || derivedError) && (
        <span className="text-[9px] text-red-400 text-right" role="alert">
          {marginError ?? derivedError}
        </span>
      )}
      {!marginError && !derivedError && belowCost && (
        <span className="text-[9px] text-red-400 text-right">Below COGS</span>
      )}
      {!marginError && !derivedError && !belowCost && driver && (
        <span className="text-[9px] text-neutral-500 text-right">
          {driver === "margin" ? "from GM%" : "from price"}
        </span>
      )}
    </div>
  );
}
