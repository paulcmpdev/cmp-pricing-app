/**
 * DTF Gang-Sheet Optimizer
 *
 * Calculates least-cost sheet purchases for a given set of transfer geometries.
 * Server-only: contains internal COGS data.
 */
import "server-only";
import { d, Decimal } from "./money";
import contract from "@/lib/fixtures/pricing-contract.json";

const SHEET_WIDTH = d(contract.dtfEngine.sheetWidthIn); // 22
const SPACING = d(contract.dtfEngine.spacingIn); // 0.25

interface SheetOption {
  label: string;
  lengthIn: number;
  publishedPrice: number;
}

const SHEET_OPTIONS: SheetOption[] = contract.dtfEngine.sheetOptions;

interface TransferGroup {
  widthIn: number;
  heightIn: number;
  totalCount: number;
}

/**
 * Calculate how many transfers fit across the 22" sheet width in a given orientation.
 */
function acrossFit(dim: number): number {
  const dimD = d(dim);
  if (dimD.gt(SHEET_WIDTH)) return 0;
  // First transfer takes its full width, each additional adds spacing + width
  const first = 1;
  const remaining = SHEET_WIDTH.minus(dimD).div(dimD.plus(SPACING)).floor().toNumber();
  return first + remaining;
}

/**
 * For a geometry, find best orientation (portrait vs landscape) for packing.
 * Returns { across, rowHeight } using whichever orientation packs more per row.
 */
function bestOrientation(w: number, h: number): { across: number; rowHeight: Decimal } {
  const portraitAcross = acrossFit(w);
  const landscapeAcross = acrossFit(h);
  const portraitRowH = d(h);
  const landscapeRowH = d(w);

  if (portraitAcross === 0 && landscapeAcross === 0) {
    throw new Error(`Transfer ${w}x${h} cannot fit on ${SHEET_WIDTH}" sheet`);
  }

  // Pick orientation with more across; if equal, pick shorter row height
  if (portraitAcross >= landscapeAcross && portraitAcross > 0) {
    return { across: portraitAcross, rowHeight: portraitRowH };
  }
  return { across: landscapeAcross, rowHeight: landscapeRowH };
}

/**
 * Calculate total length needed for a set of transfer groups on a pooled gang sheet.
 */
export function calculatePooledLength(groups: TransferGroup[]): number {
  let totalLength = d(0);

  for (const group of groups) {
    const orient = bestOrientation(group.widthIn, group.heightIn);
    const rows = d(group.totalCount).div(orient.across).ceil();
    // Each row: rowHeight + spacing (spacing between rows)
    const groupLength = rows.times(orient.rowHeight.plus(SPACING));
    totalLength = totalLength.plus(groupLength);
  }

  return totalLength.toNumber();
}

/** Sheets longest-first, matching the order the combination search has always used. */
const SORTED_SHEETS: SheetOption[] = [...SHEET_OPTIONS].sort(
  (a, b) => b.lengthIn - a.lengthIn
);

/**
 * Published prices as whole cents. Comparing candidate combinations in integer
 * cents is exact — no rounding, no epsilon — and picking the cheapest by cents
 * is identical to picking the cheapest by exact decimal dollars, so the number
 * this module returns is unchanged.
 */
const SHEET_PRICE_CENTS: number[] = SORTED_SHEETS.map((sheet) => {
  if (!Number.isInteger(sheet.lengthIn) || sheet.lengthIn <= 0) {
    throw new Error(
      `DTF sheet "${sheet.label}" length ${sheet.lengthIn} must be a positive whole number of inches.`
    );
  }
  const cents = d(sheet.publishedPrice).times(100);
  if (!cents.isInteger() || cents.isNegative()) {
    throw new Error(
      `DTF sheet "${sheet.label}" price ${sheet.publishedPrice} must be a non-negative whole number of cents.`
    );
  }
  return cents.toNumber();
});

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

/**
 * How the cost of a (large sheet, small sheet) pair repeats.
 *
 * For a required length R, a large sheet of length L costing CL and a small
 * sheet of length S costing CS, buying `k` large sheets and filling the rest
 * with small ones costs
 *
 *   F(k) = k*CL + ceil((R - k*L) / S) * CS,   k in [0, floor(R/L)]
 *
 * Let g = gcd(L, S) and p = S/g. Then p*L = S*(L/g) is a whole number of small
 * sheets, so ceil((R - (k+p)*L)/S) = ceil((R - k*L)/S) - L/g, and
 *
 *   F(k + p) - F(k) = p*CL - (L/g)*CS
 *
 * — a constant that does not depend on k or R. F is therefore an arithmetic
 * sequence along each residue class of k mod p, so its minimum over that class
 * sits at an endpoint: the smallest such k when the step is >= 0, the largest
 * when it is negative. Evaluating those p endpoints finds the exact same
 * minimum the old floor(R/L)-deep scan did, without walking thousands of k.
 */
interface ResidueStep {
  /** Distance in large-sheet counts between repeats of the cost pattern. */
  period: number;
  /** True when F is non-decreasing along a residue class. */
  minimumAtSmallestCount: boolean;
}

const RESIDUE_STEPS: ResidueStep[][] = SORTED_SHEETS.map((large, largeIndex) =>
  SORTED_SHEETS.map((small, smallIndex) => {
    const divisor = gcd(large.lengthIn, small.lengthIn);
    const period = small.lengthIn / divisor;
    const stepCents =
      period * SHEET_PRICE_CENTS[largeIndex] -
      (large.lengthIn / divisor) * SHEET_PRICE_CENTS[smallIndex];
    return { period, minimumAtSmallestCount: stepCents >= 0 };
  })
);

/**
 * How close a sheet count may drift from a whole number before the float
 * shortcut is abandoned for exact decimal arithmetic. Real drift is ~1e-9 at
 * these magnitudes; 1e-6 leaves three orders of magnitude of headroom while
 * still keeping the exact path rare.
 */
const WHOLE_SHEET_EPSILON = 1e-6;

/**
 * Small sheets needed after `largeCount` large sheets. Floats are exact for
 * every length this engine actually produces, but `ceil` is discontinuous, so
 * any quotient sitting on (or near) a whole-sheet boundary is re-settled in
 * decimal arithmetic — the same expression the exhaustive search used.
 */
function sheetsForRemainder(
  requiredLengthIn: number,
  required: Decimal,
  largeLengthIn: number,
  largeCount: number,
  smallLengthIn: number
): number {
  const remaining = requiredLengthIn - largeCount * largeLengthIn;
  const quotient = remaining / smallLengthIn;

  if (Math.abs(quotient - Math.round(quotient)) > WHOLE_SHEET_EPSILON) {
    return remaining <= 0 ? 0 : Math.ceil(quotient);
  }

  const exact = required.minus(d(largeLengthIn).times(largeCount)).div(smallLengthIn);
  return exact.lte(0) ? 0 : exact.ceil().toNumber();
}

/**
 * Find the least-cost combination of available sheet lengths to cover the
 * required length.
 *
 * Searches every "k large sheets plus enough small sheets" combination, using
 * the periodicity described on `ResidueStep` to skip the k values that cannot
 * be cheapest. Single-sheet-type purchases are the k = 0 case of the (X, X)
 * pair, whose period is always 1, so they are covered too.
 */
export function optimizePurchase(requiredLengthIn: number): number {
  const required = d(requiredLengthIn);
  if (required.lte(0)) return 0;

  let bestCents = Infinity;
  let bestLargeIndex = -1;
  let bestSmallIndex = -1;
  let bestLargeCount = 0;
  let bestSmallCount = 0;

  for (let largeIndex = 0; largeIndex < SORTED_SHEETS.length; largeIndex++) {
    const large = SORTED_SHEETS[largeIndex];
    const largeCents = SHEET_PRICE_CENTS[largeIndex];
    const maxLargeCount = Math.floor(requiredLengthIn / large.lengthIn);

    for (let smallIndex = 0; smallIndex < SORTED_SHEETS.length; smallIndex++) {
      const small = SORTED_SHEETS[smallIndex];
      const smallCents = SHEET_PRICE_CENTS[smallIndex];
      const { period, minimumAtSmallestCount } =
        RESIDUE_STEPS[largeIndex][smallIndex];

      for (
        let residue = 0;
        residue < period && residue <= maxLargeCount;
        residue++
      ) {
        const largeCount = minimumAtSmallestCount
          ? residue
          : residue + period * Math.floor((maxLargeCount - residue) / period);
        const smallCount = sheetsForRemainder(
          requiredLengthIn,
          required,
          large.lengthIn,
          largeCount,
          small.lengthIn
        );
        const cents = largeCount * largeCents + smallCount * smallCents;
        if (cents < bestCents) {
          bestCents = cents;
          bestLargeIndex = largeIndex;
          bestSmallIndex = smallIndex;
          bestLargeCount = largeCount;
          bestSmallCount = smallCount;
        }
      }
    }
  }

  if (bestLargeIndex < 0) return Infinity;

  // Money is produced by the same decimal expression as before, so the winning
  // combination converts to exactly the number the old search returned.
  return d(SORTED_SHEETS[bestLargeIndex].publishedPrice)
    .times(bestLargeCount)
    .plus(d(SORTED_SHEETS[bestSmallIndex].publishedPrice).times(bestSmallCount))
    .toNumber();
}

/**
 * Calculate the optimized purchase cost for a set of transfer groups.
 */
export function calculateOptimizedPurchase(groups: TransferGroup[]): {
  totalLength: number;
  purchaseCost: number;
} {
  const totalLength = calculatePooledLength(groups);
  const purchaseCost = optimizePurchase(totalLength);
  return { totalLength, purchaseCost };
}
