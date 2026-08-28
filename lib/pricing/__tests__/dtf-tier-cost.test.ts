import { describe, expect, it } from "vitest";
import { resolveTierCostBasis } from "../dtf-tier-cost";
import { computeBaseDecorationCogs, POOLED_BASE_MAX_QUANTITY } from "../dtf-cogs";
import contract from "@/lib/fixtures/pricing-contract.json";

const SHARED_LABOR = 36.515;

function contractTier(tier: string) {
  const found = contract.dtfEngine.tierPriceMatrix.find((t) => t.tier === tier);
  if (!found) throw new Error(`No contract tier ${tier}`);
  return found;
}

/**
 * The worst case a span has to cover, found by walking every quantity in it.
 * This is deliberately the dumbest possible implementation — it is the oracle
 * the resolver's scan is checked against.
 */
function exhaustiveWorstCase(lo: number, hi: number) {
  let cogs = computeBaseDecorationCogs(lo);
  let quantity = lo;
  for (let q = lo + 1; q <= hi; q++) {
    const candidate = computeBaseDecorationCogs(q);
    // `gt`, not `gte` — ties keep the lowest quantity, like the resolver.
    if (candidate.gt(cogs)) {
      cogs = candidate;
      quantity = q;
    }
  }
  return { cogs, quantity };
}

describe("resolveTierCostBasis — captured contract spans", () => {
  it("uses the captured COGS verbatim so baseline rows keep exact parity", () => {
    const basis = resolveTierCostBasis({ minQty: 72, maxQty: 143 });
    const tier = contractTier("72-143");

    expect(basis.source).toBe("contract");
    expect(Number(basis.totalDtfCogs)).toBeCloseTo(tier.activeTotalDtfCogs, 10);
    expect(Number(basis.laborRecovery)).toBeCloseTo(SHARED_LABOR / 72, 10);
    expect(Number(basis.baseDtfCogs)).toBeCloseTo(
      tier.activeTotalDtfCogs - SHARED_LABOR / 72,
      10
    );
    expect(basis.costingQty).toBe(tier.costingQtyWorstCase);
    expect(basis.basis).toBe(tier.pricingBasis);
  });

  it("matches the open-ended final tier against the captured capped span", () => {
    // The persisted matrix stores the last tier as open-ended (maxQty: null)
    // while the contract captured it as 2500-5000. Both mean the same span.
    const basis = resolveTierCostBasis({ minQty: 2500, maxQty: null });
    const tier = contractTier("2500+");

    expect(basis.source).toBe("contract");
    expect(basis.costingQty).toBe(tier.costingQtyWorstCase);
    expect(Number(basis.totalDtfCogs)).toBeCloseTo(tier.activeTotalDtfCogs, 10);
  });

  it("never margin-loads shared labor: base + labor reconstructs the total", () => {
    for (const tier of contract.dtfEngine.tierPriceMatrix) {
      const basis = resolveTierCostBasis({
        minQty: tier.minQty,
        maxQty: tier.maxQty,
      });
      expect(Number(basis.baseDtfCogs) + Number(basis.laborRecovery)).toBeCloseTo(
        Number(basis.totalDtfCogs),
        10
      );
      expect(Number(basis.laborRecovery)).toBeCloseTo(
        SHARED_LABOR / tier.minQty,
        10
      );
    }
  });
});

describe("resolveTierCostBasis — engine-sourced spans", () => {
  it("costs an edited span with the production engine, worst case within the span", () => {
    const basis = resolveTierCostBasis({ minQty: 13, maxQty: 20 });

    expect(basis.source).toBe("engine");

    const worst = exhaustiveWorstCase(13, 20);

    expect(Number(basis.baseDtfCogs)).toBeCloseTo(worst.cogs.toNumber(), 10);
    expect(basis.costingQty).toBe(worst.quantity);
    expect(Number(basis.laborRecovery)).toBeCloseTo(SHARED_LABOR / 13, 10);
  });

  it("reproduces the captured contract COGS when an edited span covers the same quantities", () => {
    // 72-142 is one garment short of the captured 72-143 tier, so it takes the
    // engine path — and must land on the same worst-case cost. This is what
    // makes an edited tier defensible: same engine, same answer.
    const engine = resolveTierCostBasis({ minQty: 72, maxQty: 142 });
    const captured = resolveTierCostBasis({ minQty: 72, maxQty: 143 });

    expect(engine.source).toBe("engine");
    expect(captured.source).toBe("contract");
    expect(Number(engine.baseDtfCogs)).toBeCloseTo(
      Number(captured.baseDtfCogs),
      10
    );
    expect(engine.costingQty).toBe(captured.costingQty);
  });

  it("preserves the approved 1-11 pooled-base policy for spans starting below 12", () => {
    const basis = resolveTierCostBasis({ minQty: 5, maxQty: 8 });

    expect(basis.source).toBe("engine");
    expect(basis.basis).toMatch(/12-23 pooled base-decoration proxy/);
    // Base decoration is costed against the 12-23 pooled proxy...
    expect(basis.costingQty).toBeGreaterThanOrEqual(12);
    expect(basis.costingQty).toBeLessThanOrEqual(23);
    // ...while project labor still divides by the tier's actual minimum.
    expect(Number(basis.laborRecovery)).toBeCloseTo(SHARED_LABOR / 5, 10);
  });

  it("matches the captured single-quantity tiers under the 1-11 policy", () => {
    // Contract tier "1" is a captured span, so compare its captured base COGS
    // against what the engine produces for an adjacent uncaptured span. Both
    // are costed against the same 12-23 pooled proxy.
    const engine = resolveTierCostBasis({ minQty: 1, maxQty: 2 });
    const tier = contractTier("1");
    const capturedBase = tier.activeTotalDtfCogs - SHARED_LABOR / 1;

    expect(engine.source).toBe("engine");
    expect(Number(engine.baseDtfCogs)).toBeCloseTo(capturedBase, 10);
    expect(Number(engine.laborRecovery)).toBeCloseTo(SHARED_LABOR, 10);
  });

  it("bounds an open-ended edited span to the app's supported quote range", () => {
    const basis = resolveTierCostBasis({ minQty: 3000, maxQty: null });

    expect(basis.source).toBe("engine");
    expect(basis.costingQty).toBeGreaterThanOrEqual(3000);
    expect(basis.costingQty).toBeLessThanOrEqual(
      contract.inputConstraints.quantity.maximumWithoutManagerReview
    );
  });

  it("documents its basis in a form the admin UI can display", () => {
    const basis = resolveTierCostBasis({ minQty: 13, maxQty: 20 });
    expect(basis.basis).toMatch(/at cost/);
    expect(basis.basis).toMatch(/13/);
  });
});

describe("resolveTierCostBasis — exact worst-case scan", () => {
  /**
   * Quantity 327 is the canonical sampling miss. Per-garment sheet cost
   * sawtooths at every gang-sheet row boundary, and 327 is a spike that sat
   * between the old probe samples, so a sampled span reported a cheaper basis
   * than the tier actually has to cover.
   */
  const WORST_CASE_QTY = 327;
  const WORST_CASE_BASE = 2.6800932789569875;

  it("resolves the widest span on the quantity sampling used to step over", () => {
    const basis = resolveTierCostBasis({ minQty: 250, maxQty: 5000 });

    expect(basis.source).toBe("engine");
    expect(basis.costingQty).toBe(WORST_CASE_QTY);
    // Full engine precision at the winning quantity...
    expect(computeBaseDecorationCogs(WORST_CASE_QTY).toNumber()).toBe(
      WORST_CASE_BASE
    );
    // ...and the transported basis, which is rounded for JSON only.
    expect(Number(basis.baseDtfCogs)).toBeCloseTo(WORST_CASE_BASE, 11);
    expect(Number(basis.laborRecovery)).toBeCloseTo(SHARED_LABOR / 250, 10);
  });

  it("never understates the cost of any quantity inside the span", () => {
    const basis = resolveTierCostBasis({ minQty: 250, maxQty: 5000 });
    const resolved = Number(basis.baseDtfCogs);

    let worstOvershoot = 0;
    let worstOvershootQty = 0;
    for (let q = 250; q <= 5000; q++) {
      const overshoot = computeBaseDecorationCogs(q).toNumber() - resolved;
      if (overshoot > worstOvershoot) {
        worstOvershoot = overshoot;
        worstOvershootQty = q;
      }
    }

    // A tier whose basis sits below a quantity it prices sells that quantity
    // at less than the modeled margin. 1e-12 of slack for the JSON transport
    // rounding, and nothing more.
    expect(
      worstOvershoot,
      `qty ${worstOvershootQty} costs more than the resolved basis`
    ).toBeLessThanOrEqual(1e-12);
  });

  it("equals an exhaustive loop for every kind of span the editor can produce", () => {
    // None of these match a captured contract span, so every one takes the
    // engine path — including the near-misses of captured spans.
    const spans: Array<{ minQty: number; maxQty: number }> = [
      { minQty: 12, maxQty: 12 }, // single quantity
      { minQty: 12, maxQty: 22 }, // one short of the pooled-base span
      { minQty: 24, maxQty: 47 }, // spans two captured tiers
      { minQty: 48, maxQty: 70 },
      { minQty: 72, maxQty: 142 },
      { minQty: 144, maxQty: 248 },
      { minQty: 250, maxQty: 498 },
      { minQty: 300, maxQty: 360 }, // brackets the 327 spike
      { minQty: 328, maxQty: 5000 }, // starts just past it
      { minQty: 500, maxQty: 999 },
      { minQty: 1000, maxQty: 2499 },
      { minQty: 2500, maxQty: 4999 },
      { minQty: 250, maxQty: 5000 }, // the whole custom span
    ];

    for (const span of spans) {
      const basis = resolveTierCostBasis(span);
      const worst = exhaustiveWorstCase(span.minQty, span.maxQty);

      expect(basis.source).toBe("engine");
      expect(basis.costingQty).toBe(worst.quantity);
      expect(Number(basis.baseDtfCogs)).toBeCloseTo(worst.cogs.toNumber(), 11);
    }
  });

  it("scans the tail of a small-order span instead of riding the pooled proxy up", () => {
    // 1-11 keeps the captured 12-23 pooled basis, but a span that reaches past
    // 23 still has to cover its own tail — so the tail is scanned exactly.
    const proxyOnly = resolveTierCostBasis({ minQty: 5, maxQty: 8 });
    const withTail = resolveTierCostBasis({ minQty: 5, maxQty: 400 });
    const tail = exhaustiveWorstCase(POOLED_BASE_MAX_QUANTITY + 1, 400);

    const expectedBase = Math.max(
      Number(proxyOnly.baseDtfCogs),
      tail.cogs.toNumber()
    );

    expect(withTail.source).toBe("engine");
    expect(Number(withTail.baseDtfCogs)).toBeCloseTo(expectedBase, 11);
    // Labor still divides by the tier's actual minimum, at cost.
    expect(Number(withTail.laborRecovery)).toBeCloseTo(SHARED_LABOR / 5, 10);
  });
});
