export type ProductMode = "catalog" | "vendor" | "manual";

const VENDOR_PRICING_STALE_MS = 30 * 24 * 60 * 60 * 1000;

export function isStaleVendorPricing(
  sourceSyncAt: string | null,
  now: Date = new Date()
): boolean {
  if (!sourceSyncAt) return true;
  const syncTime = new Date(sourceSyncAt).getTime();
  if (!Number.isFinite(syncTime)) return true;
  return now.getTime() - syncTime > VENDOR_PRICING_STALE_MS;
}

export function shouldClearItemQuoteForVendorSelectionChange(
  previousMode: ProductMode,
  nextMode: ProductMode
): boolean {
  return previousMode === "vendor" || nextMode === "vendor";
}

export function describeVariantAvailability({
  size,
  discontinued,
}: {
  size: string | null;
  discontinued: boolean;
}): { optionLabel: string; selectedWarning: string | null } {
  const optionLabel = `${size ?? "Unknown"}${discontinued ? " - discontinued" : ""}`;
  return {
    optionLabel,
    selectedWarning: discontinued
      ? "Selected vendor variant is discontinued. Confirm availability before quoting."
      : null,
  };
}
