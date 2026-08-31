/**
 * Output-equivalence guard for the periodic `optimizePurchase`.
 *
 * The optimizer used to walk every "k large sheets + fill the rest" candidate
 * from k = floor(R/L) down to 0. It now evaluates only one endpoint per residue
 * class of k, on the argument that the cost function is arithmetic along each
 * class. That argument is only worth as much as the evidence for it, so this
 * file keeps a verbatim copy of the old exhaustive search and asserts the two
 * return the *same double* — not a close one — across every length the engine
 * can produce.
 *
 * Sheet geometry and prices are read from pricing-contract.json rather than
 * hard-coded, so a contract change re-runs the comparison against the real
 * catalog instead of silently testing a stale one.
 */
import { describe, expect, it } from "vitest";
import { calculatePooledLength, optimizePurchase } from "../dtf-optimizer";
import { d } from "../money";
import contract from "@/lib/fixtures/pricing-contract.json";

interface SheetOption {
  label: string;
  lengthIn: number;
  publishedPrice: number;
}

const SHEET_OPTIONS: SheetOption[] = contract.dtfEngine.sheetOptions;
const SHEET_LENGTHS = SHEET_OPTIONS.map((sheet) => sheet.lengthIn);
const TRANSFER = contract.dtfEngine.capturedTransferSizeIn;

/**
 * The oracle is the *old* algorithm, so it is genuinely slow: its inner loop is
 * thousands of decimal divisions deep at the lengths a 5000-piece order needs.
 * The sweeps below stay well inside this budget, but it has to be raised off
 * the 5s default or the comparison would time out rather than fail on a real
 * divergence.
 */
const SWEEP_TIMEOUT_MS = 120_000;

/**
 * The previous implementation, copied verbatim from the commit before the
 * periodic rewrite (9600498, `lib/pricing/dtf-optimizer.ts`). Intentionally not
 * refactored, not sped up, and not sharing any helper with production beyond
 * `d` and the contract sheet list — it is the oracle, so it has to be the old
 * code, quirks included.
 */
function exhaustiveOptimizePurchase(requiredLengthIn: number): number {
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
    for (
      let largeCount = Math.floor(requiredLengthIn / large.lengthIn);
      largeCount >= 0;
      largeCount--
    ) {
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
        const cost = d(large.publishedPrice)
          .times(largeCount)
          .plus(d(small.publishedPrice).times(smallCount))
          .toNumber();
        if (cost < bestCost) bestCost = cost;
      }
    }
  }

  return bestCost;
}

/**
 * Exact equality, with the offending length named. `toBe` on numbers is an
 * `Object.is` comparison, so this fails on a one-ULP drift — which is the point:
 * the rewrite claims the returned number is unchanged, not merely close.
 */
function expectEquivalent(lengthIn: number, note?: string): void {
  const label = note ? `${lengthIn} (${note})` : `${lengthIn}`;
  expect(
    optimizePurchase(lengthIn),
    `optimizePurchase(${label}) diverged from the exhaustive search`
  ).toBe(exhaustiveOptimizePurchase(lengthIn));
}

/** Pooled sheet length the production engine produces for an order quantity. */
function pooledLengthForQuantity(quantity: number): number {
  return calculatePooledLength([
    {
      widthIn: TRANSFER.width,
      heightIn: TRANSFER.height,
      totalCount: quantity,
    },
  ]);
}

describe("optimizePurchase — contract sheet catalog", () => {
  it("reads a usable sheet catalog from pricing-contract.json", () => {
    // The equivalence sweeps below are only meaningful if they run against a
    // real multi-sheet catalog, so assert the fixture still is one.
    expect(SHEET_OPTIONS.length).toBeGreaterThan(1);
    for (const sheet of SHEET_OPTIONS) {
      expect(Number.isInteger(sheet.lengthIn)).toBe(true);
      expect(sheet.lengthIn).toBeGreaterThan(0);
      expect(sheet.publishedPrice).toBeGreaterThan(0);
    }
  });
});

describe("optimizePurchase — nonpositive lengths", () => {
  it("returns exactly zero, matching the exhaustive search", () => {
    const nonpositive = [
      0,
      -0,
      -1e-9,
      -0.01,
      -0.25,
      -1,
      -10.25,
      -SHEET_LENGTHS[0],
      -Math.max(...SHEET_LENGTHS),
      -25625,
    ];

    for (const lengthIn of nonpositive) {
      expect(optimizePurchase(lengthIn), `optimizePurchase(${lengthIn})`).toBe(0);
      expectEquivalent(lengthIn, "nonpositive");
    }
  });
});

describe("optimizePurchase — sheet boundaries", () => {
  /**
   * Boundaries are where the two algorithms could most plausibly disagree: the
   * remainder `ceil` is discontinuous there, and the rewrite takes a float
   * shortcut that falls back to decimal arithmetic near whole-sheet counts.
   * Both sides of every boundary are probed, at three magnitudes of offset:
   * 0.25" (the engine's own row spacing), a cent-scale 0.01", and 1e-9" —
   * small enough to sit inside the rewrite's whole-sheet epsilon.
   */
  const OFFSETS = [-0.25, -0.01, -1e-9, 0, 1e-9, 0.01, 0.25];

  it("matches at exact single-sheet lengths and just either side of them", () => {
    for (const lengthIn of SHEET_LENGTHS) {
      for (const offset of OFFSETS) {
        expectEquivalent(lengthIn + offset, `sheet ${lengthIn} ${offset}`);
      }
    }
  });

  it(
    "matches at whole multiples of every sheet and just either side of them",
    () => {
      for (const lengthIn of SHEET_LENGTHS) {
        for (const multiple of [2, 3, 4, 7, 13]) {
          for (const offset of OFFSETS) {
            expectEquivalent(
              lengthIn * multiple + offset,
              `${multiple}x sheet ${lengthIn} ${offset}`
            );
          }
        }
      }
    },
    SWEEP_TIMEOUT_MS
  );

  it("matches at sums of two different sheets and just either side of them", () => {
    for (const large of SHEET_LENGTHS) {
      for (const small of SHEET_LENGTHS) {
        for (const offset of [-0.01, 0, 0.01]) {
          expectEquivalent(large + small + offset, `${large}+${small} ${offset}`);
        }
      }
    }
  });

  it(
    "matches across a dense quarter-inch sweep spanning the small sheets",
    () => {
      // 0.25" is the engine's row spacing, so every pooled length is a multiple
      // of it; this walks 1200 of them end to end with no gaps.
      for (let quarters = 1; quarters <= 1200; quarters++) {
        expectEquivalent(quarters * 0.25, "quarter-inch sweep");
      }
    },
    SWEEP_TIMEOUT_MS
  );
});

describe("optimizePurchase — pooled lengths from real order quantities", () => {
  it(
    "matches for every quantity from 1 to 500",
    () => {
      for (let quantity = 1; quantity <= 500; quantity++) {
        const lengthIn = pooledLengthForQuantity(quantity);
        expect(
          optimizePurchase(lengthIn),
          `quantity ${quantity} (pooled length ${lengthIn}) diverged`
        ).toBe(exhaustiveOptimizePurchase(lengthIn));
      }
    },
    SWEEP_TIMEOUT_MS
  );

  it(
    "matches for representative large quantities through 5000",
    () => {
      const quantities = new Set<number>();
      // Every 100th quantity across the app's full supported range...
      for (let quantity = 500; quantity <= 5000; quantity += 100) {
        quantities.add(quantity);
      }
      // ...plus the tier boundaries and the known sawtooth spike, where the
      // per-garment cost the matrix prices off is most sensitive.
      for (const quantity of [
        327, 501, 999, 1000, 1001, 1499, 1500, 2499, 2500, 2501, 4999, 5000,
      ]) {
        quantities.add(quantity);
      }

      for (const quantity of [...quantities].sort((a, b) => a - b)) {
        const lengthIn = pooledLengthForQuantity(quantity);
        expect(
          optimizePurchase(lengthIn),
          `quantity ${quantity} (pooled length ${lengthIn}) diverged`
        ).toBe(exhaustiveOptimizePurchase(lengthIn));
      }
    },
    SWEEP_TIMEOUT_MS
  );

  it(
    "matches for very long multi-sheet requirements",
    () => {
      // Lengths well past anything a 5000-piece order produces, so the periodic
      // shortcut is exercised where the old scan was thousands of steps deep.
      const lengths = [
        6_000, 9_600, 10_000.25, 12_345.75, 20_000, 25_625, 30_000.5, 48_000,
        57_600.25,
      ];

      for (const lengthIn of lengths) {
        expectEquivalent(lengthIn, "long requirement");
      }
    },
    SWEEP_TIMEOUT_MS
  );
});
