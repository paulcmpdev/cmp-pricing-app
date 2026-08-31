import { describe, expect, it } from "vitest";
import {
  DtfMatrixPreviewBodySchema,
  calculateMatrixPreview,
  calculateQuoteImpact,
  type DtfMatrixDraft,
} from "../dtf-matrix-preview";
import { resolveTierCostBasis } from "../dtf-tier-cost";
import { priceFromMargin } from "../dtf-margin-math";
import { getBaselineDtfMatrix } from "@/lib/server/pricing-config/baseline";
import contract from "@/lib/fixtures/pricing-contract.json";

const baseline = () => getBaselineDtfMatrix() as DtfMatrixDraft;

/**
 * A small, fully custom matrix: renamed lanes, custom spans, extra lane.
 *
 * "Starter" spans 1-24, so it is costed at its worst case — quantity 1, where
 * the whole $36.515 of shared project labor is recovered over a single
 * garment on top of the ~$5.58 pooled base decoration COGS. Its prices are
 * therefore set above ~$42.09; anything less is genuinely below cost for this
 * span, not a quirk of the model.
 */
function customMatrix(): DtfMatrixDraft {
  return {
    lanes: [
      { key: "RETAIL", label: "Retail", margin: 0.5, active: true },
      { key: "TEAM", label: "Team Program", margin: 0.4, active: true },
      { key: "LEGACY", label: "Legacy", margin: 0.3, active: false },
    ],
    tiers: [
      {
        tier: "Starter",
        minQty: 1,
        maxQty: 24,
        prices: { RETAIL: 48, TEAM: 46, LEGACY: 44 },
      },
      {
        tier: "Growth",
        minQty: 25,
        maxQty: null,
        prices: { RETAIL: 9, TEAM: 8, LEGACY: 7 },
      },
    ],
  };
}

describe("calculateMatrixPreview — dynamic lanes and tiers", () => {
  it("derives DTF GM% for renamed, non-T1..T4 lane keys", () => {
    const preview = calculateMatrixPreview(customMatrix());

    expect(preview.tiers).toHaveLength(2);
    expect(Object.keys(preview.tiers[0].lanes).sort()).toEqual([
      "RETAIL",
      "TEAM",
    ]);
    expect(preview.tiers[0].lanes.RETAIL.price).toBe("48.00");
    expect(Number(preview.tiers[0].lanes.RETAIL.margin)).toBeGreaterThan(0);
    expect(preview.tiers[0].lanes.RETAIL.error).toBeNull();
  });

  it("omits inactive lanes — they carry no price for this matrix", () => {
    const preview = calculateMatrixPreview(customMatrix());
    expect(preview.tiers[0].lanes.LEGACY).toBeUndefined();
  });

  it("supports a lane added after the fact without any code change", () => {
    const config = customMatrix();
    config.lanes.push({ key: "VIP", label: "VIP", margin: 0.6, active: true });
    for (const tier of config.tiers) tier.prices.VIP = 50;

    const preview = calculateMatrixPreview(config);
    expect(preview.tiers[0].lanes.VIP.price).toBe("50.00");
    expect(preview.tiers[1].lanes.VIP.price).toBe("50.00");
  });

  it("resolves a cost basis for custom tier spans and keys it by span only", () => {
    const preview = calculateMatrixPreview(customMatrix());

    expect(preview.tiers[0].costKey).toBe("1:24");
    expect(preview.tiers[1].costKey).toBe("25:+");
    expect(preview.costBases["1:24"]).toBeDefined();
    expect(preview.costBases["25:+"]).toBeDefined();
    expect(preview.tiers[0].costBasis.source).toBe("engine");
  });

  it("reports a missing lane price inline instead of throwing", () => {
    const config = customMatrix();
    delete config.tiers[0].prices.TEAM;

    const preview = calculateMatrixPreview(config);
    expect(preview.tiers[0].lanes.TEAM.error).toMatch(/no price for lane "TEAM"/);
    expect(preview.tiers[0].lanes.TEAM.margin).toBeNull();
  });

  it("reports a price at or below labor recovery inline, never NaN or Infinity", () => {
    const config = customMatrix();
    // Tier "Starter" recovers 36.515 of project labor over qty 1.
    config.tiers[0].prices.RETAIL = 1;

    const preview = calculateMatrixPreview(config);
    const lane = preview.tiers[0].lanes.RETAIL;

    expect(lane.margin).toBeNull();
    expect(lane.marginPercent).toBeNull();
    expect(lane.error).toMatch(/at-cost labor recovery/);
    expect(lane.belowCost).toBe(true);
  });

  it("flags a price that covers labor but not base COGS as below cost", () => {
    const config = customMatrix();

    // A negative margin and an undefined margin are different failures. To
    // exercise the negative-margin path the price has to sit strictly between
    // labor recovery and total COGS: "Growth" (25+) recovers 36.515 / 25 =
    // $1.46 of labor at cost on top of its base decoration COGS, so $3.00
    // clears labor but not base.
    const basis = resolveTierCostBasis({ minQty: 25, maxQty: null });
    expect(Number(basis.laborRecovery)).toBeLessThan(3);
    expect(Number(basis.totalDtfCogs)).toBeGreaterThan(3);

    config.tiers[1].prices.RETAIL = 3;

    const preview = calculateMatrixPreview(config);
    const lane = preview.tiers[1].lanes.RETAIL;

    expect(lane.error).toBeNull();
    expect(Number(lane.margin)).toBeLessThan(0);
    expect(lane.belowCost).toBe(true);
  });

  it("never embeds the commission reserve in lane margin or the multiplier", () => {
    const preview = calculateMatrixPreview(baseline());
    expect(preview.pricingPolicy.commissionReserveRate).toBe(0.08);
    expect(preview.pricingPolicy.productCostMultiplier).toBe(2);
  });
});

describe("calculateMatrixPreview — baseline parity", () => {
  const preview = calculateMatrixPreview(baseline());
  const config = baseline();

  it("preserves every captured baseline price exactly", () => {
    for (const [i, tier] of config.tiers.entries()) {
      const captured = contract.dtfEngine.tierPriceMatrix[i];
      expect(preview.tiers[i].tier).toBe(captured.tier);
      for (const lane of config.lanes) {
        expect(preview.tiers[i].lanes[lane.key].price).toBe(
          captured.prices[lane.key as keyof typeof captured.prices].toFixed(2)
        );
      }
    }
  });

  it("sources every baseline tier's cost basis from the captured contract", () => {
    for (const tier of preview.tiers) {
      expect(tier.costBasis.source).toBe("contract");
    }
  });

  it("derives a DTF GM% at or just above each lane's target margin", () => {
    // Baseline prices were produced by rounding UP from the lane target, so
    // the derived margin must land at or slightly above it — never below.
    for (const tier of preview.tiers) {
      for (const lane of config.lanes) {
        const derived = Number(tier.lanes[lane.key].margin);
        expect(derived).toBeGreaterThanOrEqual(lane.margin - 0.001);
        expect(derived).toBeLessThan(lane.margin + 0.05);
      }
    }
  });

  it("keeps the 72-143 / T1 baseline row on its known value", () => {
    const tier = preview.tiers.find((t) => t.tier === "72-143");
    expect(tier?.lanes.T1.price).toBe("6.55");
    expect(Number(tier?.lanes.T1.marginPercent)).toBeCloseTo(50.24, 1);
  });
});

describe("calculateQuoteImpact", () => {
  const quote = { productCost: 4.8, quantity: 174, lane: "T1" };

  it("compares the saved configuration against the unsaved draft", () => {
    const saved = baseline();
    const draft = baseline();
    const tierIdx = draft.tiers.findIndex((t) => t.tier === "144-249");
    draft.tiers[tierIdx].prices.T1 = 9.0;

    const result = calculateQuoteImpact({ draft, current: saved, quote });
    if (!result.available) throw new Error(result.message);

    expect(result.current?.decorationSell).toBe(
      saved.tiers[tierIdx].prices.T1.toFixed(2)
    );
    expect(result.draft.decorationSell).toBe("9.00");
    // Product Sell = product cost x 2.00, identical on both sides.
    expect(result.draft.productSell).toBe("9.60");
    expect(result.delta?.productSell).toBe("0.00");
  });

  it("reacts to a draft price change", () => {
    const saved = baseline();
    const before = calculateQuoteImpact({ draft: baseline(), current: saved, quote });

    const draft = baseline();
    const tierIdx = draft.tiers.findIndex((t) => t.tier === "144-249");
    const original = draft.tiers[tierIdx].prices.T1;
    draft.tiers[tierIdx].prices.T1 = original + 1;
    const after = calculateQuoteImpact({ draft, current: saved, quote });

    if (!before.available || !after.available) throw new Error("unavailable");
    expect(before.delta?.unitPrice).toBe("0.00");
    expect(after.delta?.unitPrice).toBe("1.00");
    expect(after.delta?.orderTotal).toBe("174.00");
    expect(Number(after.delta?.orderPercent)).toBeGreaterThan(0);
  });

  it("reacts to a margin-driven change through the resulting price", () => {
    // A DTF GM% edit is stored as the price that margin produces, so Quote
    // Impact must respond identically whichever field the admin typed into.
    const saved = baseline();
    const tierIdx = saved.tiers.findIndex((t) => t.tier === "144-249");
    const basis = resolveTierCostBasis({
      minQty: saved.tiers[tierIdx].minQty,
      maxQty: saved.tiers[tierIdx].maxQty,
    });

    // The admin types 60 into DTF GM%.
    const converted = priceFromMargin(basis, 0.6);
    if (!converted.ok) throw new Error(converted.message);
    expect(Number(converted.final)).toBeGreaterThan(
      saved.tiers[tierIdx].prices.T1
    );

    const fromMargin = baseline();
    fromMargin.tiers[tierIdx].prices.T1 = Number(converted.final);

    // The same admin could have typed that price directly instead.
    const fromPrice = baseline();
    fromPrice.tiers[tierIdx].prices.T1 = Number(converted.final);

    const viaMargin = calculateQuoteImpact({ draft: fromMargin, current: saved, quote });
    const viaPrice = calculateQuoteImpact({ draft: fromPrice, current: saved, quote });

    expect(viaMargin).toEqual(viaPrice);
    if (!viaMargin.available) throw new Error(viaMargin.message);
    expect(viaMargin.draft.decorationSell).toBe(converted.final);
    expect(Number(viaMargin.delta?.orderTotal)).toBeGreaterThan(0);
    // The GM% the admin asked for is what the stored price delivers.
    expect(Number(converted.achievedMargin)).toBeGreaterThanOrEqual(0.6);
  });

  it("reports the commission reserve as an outcome, not a price input", () => {
    const result = calculateQuoteImpact({
      draft: baseline(),
      current: baseline(),
      quote,
    });
    if (!result.available) throw new Error(result.message);

    const unit = Number(result.draft.unitPrice);
    expect(Number(result.draft.commissionReserve)).toBeCloseTo(unit * 0.08, 2);
    // Net contribution is gross profit minus the reserve — a reported outcome.
    expect(Number(result.draft.netContributionAfterCommission)).toBeCloseTo(
      Number(result.draft.grossProfitBeforeCommission) -
        Number(result.draft.commissionReserve),
      2
    );
  });

  it("uses the same modeled COGS on both sides so the delta is price-only", () => {
    const saved = baseline();
    const draft = baseline();
    draft.tiers[draft.tiers.findIndex((t) => t.tier === "144-249")].prices.T1 = 12;

    const result = calculateQuoteImpact({ draft, current: saved, quote });
    if (!result.available) throw new Error(result.message);

    expect(result.draft.modeledDecorationCogs).toBe(
      result.current?.modeledDecorationCogs
    );
    expect(result.delta?.grossProfitBeforeCommission).toBe(
      result.delta?.unitPrice
    );
  });

  it("selects the draft tier by quantity, including a retiered draft", () => {
    const draft: DtfMatrixDraft = {
      lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
      tiers: [
        { tier: "1-99", minQty: 1, maxQty: 99, prices: { T1: 20 } },
        { tier: "100+", minQty: 100, maxQty: null, prices: { T1: 6 } },
      ],
    };

    const result = calculateQuoteImpact({ draft, quote });
    if (!result.available) throw new Error(result.message);
    expect(result.draft.tier).toBe("100+");
    expect(result.draft.decorationSell).toBe("6.00");
  });

  it("explains itself when a new lane has no saved counterpart", () => {
    const saved = baseline();
    const draft = baseline();
    draft.lanes.push({ key: "VIP", label: "VIP", margin: 0.6, active: true });
    for (const tier of draft.tiers) tier.prices.VIP = 12;

    const result = calculateQuoteImpact({
      draft,
      current: saved,
      quote: { ...quote, lane: "VIP" },
    });

    if (!result.available) throw new Error(result.message);
    expect(result.current).toBeNull();
    expect(result.delta).toBeNull();
    expect(result.currentUnavailableReason).toMatch(/new/i);
    expect(result.draft.decorationSell).toBe("12.00");
  });

  it("reports unavailability when no draft tier covers the quantity", () => {
    const draft: DtfMatrixDraft = {
      lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
      tiers: [{ tier: "1-10", minQty: 1, maxQty: 10, prices: { T1: 20 } }],
    };

    const result = calculateQuoteImpact({ draft, quote });
    expect(result.available).toBe(false);
    if (result.available) throw new Error("expected unavailable");
    expect(result.reason).toBe("no_draft_tier");
  });

  it("reports unavailability when the draft tier has no price for the lane", () => {
    const draft: DtfMatrixDraft = {
      lanes: [
        { key: "T1", label: "T1", margin: 0.5, active: true },
        { key: "T9", label: "T9", margin: 0.5, active: true },
      ],
      tiers: [{ tier: "1+", minQty: 1, maxQty: null, prices: { T1: 20 } }],
    };

    const result = calculateQuoteImpact({ draft, quote: { ...quote, lane: "T9" } });
    expect(result.available).toBe(false);
    if (result.available) throw new Error("expected unavailable");
    expect(result.reason).toBe("no_draft_price");
  });
});

describe("DtfMatrixPreviewBodySchema", () => {
  it("accepts a draft with dynamic lane keys and an optional saved comparison", () => {
    const parsed = DtfMatrixPreviewBodySchema.safeParse({
      draft: customMatrix(),
      current: customMatrix(),
      quote: { productCost: 4.8, quantity: 174, lane: "RETAIL" },
    });
    expect(parsed.success).toBe(true);
  });

  it("requires a draft", () => {
    expect(DtfMatrixPreviewBodySchema.safeParse({}).success).toBe(false);
  });

  it("rejects unknown top-level keys", () => {
    const parsed = DtfMatrixPreviewBodySchema.safeParse({
      draft: customMatrix(),
      padding: "x".repeat(1000),
    });
    expect(parsed.success).toBe(false);
  });

  it("bounds the matrix so request bodies stay small", () => {
    const tooManyLanes = customMatrix();
    tooManyLanes.lanes = Array.from({ length: 21 }, (_, i) => ({
      key: `L${i}`,
      label: `L${i}`,
      margin: 0.4,
      active: true,
    }));
    expect(
      DtfMatrixPreviewBodySchema.safeParse({ draft: tooManyLanes }).success
    ).toBe(false);

    const tooManyTiers = customMatrix();
    tooManyTiers.tiers = Array.from({ length: 51 }, (_, i) => ({
      tier: `T${i}`,
      minQty: i + 1,
      maxQty: i + 1,
      prices: { RETAIL: 10 },
    }));
    expect(
      DtfMatrixPreviewBodySchema.safeParse({ draft: tooManyTiers }).success
    ).toBe(false);
  });

  it("rejects prices for lanes the draft never declared", () => {
    const config = customMatrix();
    config.tiers[0].prices.GHOST = 5;
    expect(DtfMatrixPreviewBodySchema.safeParse({ draft: config }).success).toBe(
      false
    );
  });

  it("bounds the quote quantity to the app's supported range", () => {
    const overMax = DtfMatrixPreviewBodySchema.safeParse({
      draft: customMatrix(),
      quote: {
        productCost: 4.8,
        quantity:
          contract.inputConstraints.quantity.maximumWithoutManagerReview + 1,
        lane: "RETAIL",
      },
    });
    expect(overMax.success).toBe(false);
  });
});
