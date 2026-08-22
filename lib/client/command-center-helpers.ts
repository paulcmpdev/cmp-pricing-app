/**
 * Pure helper functions for the Command Center concept.
 * No React, no API calls — just formatting, classification, and composition.
 */

export type MarginLevel = "healthy" | "moderate" | "thin" | "negative";

/** Classify a margin (0–1 scale) for visual treatment. */
export function classifyMargin(margin: number): MarginLevel {
  if (margin >= 0.4) return "healthy";
  if (margin >= 0.2) return "moderate";
  if (margin >= 0) return "thin";
  return "negative";
}

/** Convert margin (0–1) to a percentage width clamped 0–100 for bar display. */
export function marginBarWidth(margin: number): number {
  const pct = Math.round(margin * 100);
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

/** Compute combined order summary from item and flat-fee quotes. */
export function computeOrderSummary(
  itemTotal: number | null,
  addOnTotal: number | null
): { grandTotal: number; hasAddOn: boolean } {
  const item = itemTotal ?? 0;
  const addOn = addOnTotal ?? 0;
  return {
    grandTotal: item + addOn,
    hasAddOn: addOn > 0,
  };
}

/** Whether quantity needs a manager-review flag. */
export function isHighVolume(quantity: number): boolean {
  return Number.isFinite(quantity) && quantity > 5000;
}

/** Parse a string to a positive integer, or null if invalid. Rejects decimals. */
export function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  if (n < 1) return null;
  return n;
}

/** Parse a string to a non-negative float, or null if invalid. */
export function parseNonNegativeFloat(value: string): number | null {
  const n = parseFloat(value);
  if (isNaN(n) || n < 0) return null;
  return n;
}
