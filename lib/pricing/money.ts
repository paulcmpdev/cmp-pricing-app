import Decimal from "decimal.js";

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export type DecimalLike = Decimal | number | string;

export function d(value: DecimalLike): Decimal {
  return new Decimal(value);
}

export function displayCurrency(value: DecimalLike): string {
  return d(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function displayPercent(value: DecimalLike, decimals = 1): string {
  return d(value).times(100).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed(decimals) + "%";
}

export function ceilToWholeDollar(value: DecimalLike): number {
  return d(value).ceil().toNumber();
}

export function roundUpToIncrement(value: DecimalLike, increment: DecimalLike): Decimal {
  const inc = d(increment);
  const val = d(value);
  return val.div(inc).ceil().times(inc);
}

export { Decimal };
