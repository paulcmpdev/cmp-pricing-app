export type ProductMode = "catalog" | "vendor" | "manual";

type SizeSortableVariant = {
  size: string | null;
  sizeOrder?: number | null;
};

const NATURAL_SIZE_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

const APPAREL_SIZE_RANK = new Map<string, number>([
  ["XXS", 0],
  ["XXST", 5],
  ["XS", 10],
  ["XST", 15],
  ["S", 20],
  ["ST", 22],
  ["S/M", 25],
  ["M", 30],
  ["MT", 32],
  ["M/L", 35],
  ["L", 40],
  ["LT", 42],
  ["L/XL", 45],
  ["XL", 50],
  ["XLT", 52],
  ["XL/2XL", 55],
  ["2XL", 60],
  ["2XLT", 62],
  ["3XL", 70],
  ["3XLT", 72],
  ["4XL", 80],
  ["4XLT", 82],
  ["5XL", 90],
  ["5XLT", 92],
  ["6XL", 100],
  ["6XLT", 102],
  ["7XL", 110],
  ["8XL", 120],
  ["9XL", 130],
  ["10XL", 140],
]);

function normalizeApparelSize(size: string | null): string | null {
  if (!size) return null;
  let normalized = size.trim().toUpperCase().replace(/\s+/g, "");
  if (normalized.startsWith("YOUTH")) normalized = normalized.slice("YOUTH".length);
  if (/^Y(?:XXS|XS|S|M|L|XL)$/.test(normalized)) {
    normalized = normalized.slice(1);
  }
  const tallLabel = normalized.match(/^(XXS|XS|S|M|L|XL|\d+XL)TALL$/);
  if (tallLabel) normalized = `${tallLabel[1]}T`;
  const repeatedXTall = normalized.match(/^(X{2,})LT$/);
  if (repeatedXTall) normalized = `${repeatedXTall[1].length}XLT`;
  const repeatedX = normalized.match(/^(X{2,})L$/);
  if (repeatedX) normalized = `${repeatedX[1].length}XL`;
  if (/^\d+X$/.test(normalized)) normalized = `${normalized}L`;
  return normalized;
}

function apparelSizeRank(size: string | null): number | null {
  const normalized = normalizeApparelSize(size);
  return normalized === null ? null : APPAREL_SIZE_RANK.get(normalized) ?? null;
}

/**
 * Returns a sorted copy for dropdown display without mutating source data.
 * Canonical apparel labels win over unreliable/colliding vendor sizeOrder values;
 * unfamiliar size systems preserve vendor order and then use natural numeric text.
 */
export function sortVendorSizeVariants<T extends SizeSortableVariant>(variants: readonly T[]): T[] {
  return variants.map((variant, index) => ({ variant, index })).sort((a, b) => {
    const aRank = apparelSizeRank(a.variant.size);
    const bRank = apparelSizeRank(b.variant.size);
    if (aRank !== null && bRank !== null && aRank !== bRank) return aRank - bRank;
    if (aRank !== null && bRank === null) return -1;
    if (aRank === null && bRank !== null) return 1;

    const aOrder = Number.isFinite(a.variant.sizeOrder) ? a.variant.sizeOrder! : null;
    const bOrder = Number.isFinite(b.variant.sizeOrder) ? b.variant.sizeOrder! : null;
    if (aOrder !== null && bOrder !== null && aOrder !== bOrder) return aOrder - bOrder;
    if (aOrder !== null && bOrder === null) return -1;
    if (aOrder === null && bOrder !== null) return 1;

    if (a.variant.size === null && b.variant.size !== null) return 1;
    if (a.variant.size !== null && b.variant.size === null) return -1;
    const natural = NATURAL_SIZE_COLLATOR.compare(a.variant.size ?? "", b.variant.size ?? "");
    return natural || a.index - b.index;
  }).map(({ variant }) => variant);
}

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
}): { optionLabel: string; disabled: boolean } {
  const optionLabel = `${size ?? "Unknown"}${discontinued ? " - discontinued" : ""}`;
  return {
    optionLabel,
    disabled: discontinued,
  };
}
