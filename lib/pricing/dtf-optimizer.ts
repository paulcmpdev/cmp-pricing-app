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

/**
 * Find the least-cost combination of available sheet lengths to cover the required length.
 * Uses a greedy approach: always pick the sheet that covers the most remaining length per dollar.
 */
export function optimizePurchase(requiredLengthIn: number): number {
  const required = d(requiredLengthIn);
  if (required.lte(0)) return 0;

  // Sort sheets by length descending for combination search
  const sortedSheets = [...SHEET_OPTIONS].sort((a, b) => b.lengthIn - a.lengthIn);

  // Dynamic programming / greedy: try all feasible combinations
  // For practical purposes, use a simple greedy approach
  let bestCost = Infinity;

  // Try using single sheet types first
  for (const sheet of sortedSheets) {
    const count = d(requiredLengthIn).div(sheet.lengthIn).ceil().toNumber();
    const cost = d(sheet.publishedPrice).times(count).toNumber();
    if (cost < bestCost) bestCost = cost;
  }

  // Try 2-sheet combinations: use as many of the larger as possible, fill remainder with best smaller
  for (let i = 0; i < sortedSheets.length; i++) {
    const large = sortedSheets[i];
    for (let largeCount = Math.floor(requiredLengthIn / large.lengthIn); largeCount >= 0; largeCount--) {
      const covered = d(large.lengthIn).times(largeCount);
      const remaining = required.minus(covered);
      if (remaining.lte(0)) {
        const cost = d(large.publishedPrice).times(largeCount).toNumber();
        if (cost < bestCost) bestCost = cost;
        continue;
      }
      // Find cheapest sheet to cover remainder
      for (const small of sortedSheets) {
        const smallCount = remaining.div(small.lengthIn).ceil().toNumber();
        const cost = d(large.publishedPrice).times(largeCount).plus(d(small.publishedPrice).times(smallCount)).toNumber();
        if (cost < bestCost) bestCost = cost;
      }
    }
  }

  return bestCost;
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
