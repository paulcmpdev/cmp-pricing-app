export function fmtCurrency(value: string | number): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (!Number.isFinite(n)) return "--";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtPercent(decimalValue: string | number, decimals = 1): string {
  const n = typeof decimalValue === "string" ? parseFloat(decimalValue) : decimalValue;
  if (!Number.isFinite(n)) return "--";
  return (n * 100).toFixed(decimals) + "%";
}

export function fmtWholePercent(decimalValue: string | number): string {
  const n = typeof decimalValue === "string" ? parseFloat(decimalValue) : decimalValue;
  if (!Number.isFinite(n)) return "--";
  return Math.round(n * 100) + "%";
}

export function fmtQtyRange(min: number, max: number): string {
  if (max >= 5000) return `${min.toLocaleString()}+`;
  if (min === max) return String(min);
  return `${min.toLocaleString()}-${max.toLocaleString()}`;
}

export function fmtDelta(value: string | number): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (!Number.isFinite(n)) return "--";
  const abs = Math.abs(n);
  const formatted = "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n > 0) return "+" + formatted;
  if (n < 0) return "-" + formatted;
  return formatted;
}

export function fmtDeltaPercent(decimalValue: string | number): string {
  const n = typeof decimalValue === "string" ? parseFloat(decimalValue) : decimalValue;
  if (!Number.isFinite(n)) return "--";
  const sign = n > 0 ? "+" : "";
  return sign + (n * 100).toFixed(1) + "%";
}

export function marginWarning(percent: number): string | null {
  if (percent < 20) return "Below 20% - review recommended";
  if (percent > 70) return "Above 70% - review recommended";
  return null;
}
