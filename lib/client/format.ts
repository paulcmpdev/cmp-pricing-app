/**
 * Client-safe formatting utilities.
 * Uses Decimal.js ROUND_HALF_UP for deterministic currency rounding.
 */
import Decimal from "decimal.js";

const ROUND_HALF_UP = Decimal.ROUND_HALF_UP;

export function formatCurrency(value: number): string {
  const rounded = new Decimal(value)
    .toDecimalPlaces(2, ROUND_HALF_UP)
    .toFixed(2);
  const [whole, frac] = rounded.split(".");
  const isNeg = whole.startsWith("-");
  const absWhole = isNeg ? whole.slice(1) : whole;
  const grouped = absWhole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${isNeg ? "-" : ""}$${grouped}.${frac}`;
}

export function formatPercent(value: number, decimals = 1): string {
  return new Decimal(value)
    .times(100)
    .toDecimalPlaces(decimals, ROUND_HALF_UP)
    .toFixed(decimals) + "%";
}
