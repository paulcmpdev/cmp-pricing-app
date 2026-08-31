import { describe, expect, it } from "vitest";
import {
  marginFromPrice,
  priceFromMargin,
  tierCostKey,
} from "../dtf-margin-math";

// Baseline 72-143 tier, derived from pricing-contract.json:
//   activeTotalDtfCogs 3.514329848783695
//   laborRecovery      36.515 / 72 = 0.5071527777...
//   baseDtfCogs        3.514329848783695 - 0.5071527777... = 3.0071770710...
const TIER_72_143 = {
  baseDtfCogs: "3.0071770710",
  laborRecovery: "0.5071527778",
};

describe("priceFromMargin", () => {
  it("margin-loads base COGS only and adds shared labor at cost", () => {
    const result = priceFromMargin(TIER_72_143, "0.5");
    if (!result.ok) throw new Error(result.message);

    // 3.0071770710 / 0.5 = 6.0143541420 (labor is NOT margin-loaded)
    expect(result.marginLoadedAmount).toBe("6.014354142");
    // + 0.5071527778 = 6.5215069198
    expect(result.raw).toBe("6.5215069198");
  });

  it("rounds the direct price UP to the configured $0.05 increment", () => {
    const result = priceFromMargin(TIER_72_143, "0.5");
    if (!result.ok) throw new Error(result.message);

    expect(result.final).toBe("6.55");
    expect(result.increment).toBe("0.05");
  });

  it("reports the margin actually achieved after rounding up", () => {
    const result = priceFromMargin(TIER_72_143, "0.5");
    if (!result.ok) throw new Error(result.message);

    // Rounding up always lands at or above the target margin.
    expect(Number(result.achievedMargin)).toBeGreaterThan(0.5);
    expect(Number(result.achievedMargin)).toBeLessThan(0.51);
  });

  it("honours a non-default rounding increment", () => {
    const result = priceFromMargin(TIER_72_143, "0.5", "1");
    if (!result.ok) throw new Error(result.message);
    expect(result.final).toBe("7.00");
  });

  // Explicit tuple type: without it, Vitest widens the mixed string/number
  // column and the callback parameter no longer types cleanly.
  it.each<[margin: string | number, description: string]>([
    ["1", "a margin of 100%"],
    ["1.5", "a margin above 100%"],
    ["-0.01", "a negative margin"],
    [Number.NaN, "a non-numeric margin"],
  ])("rejects %s (%s) instead of returning Infinity/NaN", (margin) => {
    const result = priceFromMargin(TIER_72_143, margin);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("invalid_margin");
    expect(result.message).toMatch(/less than 100%/i);
  });

  it("rejects an unusable cost basis", () => {
    const result = priceFromMargin(
      { baseDtfCogs: "NaN", laborRecovery: "0.5" },
      "0.5"
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("invalid_basis");
  });
});

describe("marginFromPrice", () => {
  it("derives the DTF margin by reversing the price formula", () => {
    const result = marginFromPrice(TIER_72_143, "6.55");
    if (!result.ok) throw new Error(result.message);

    // net    = 6.55 - 0.5071527778 = 6.0428472222
    // margin = (6.0428472222 - 3.0071770710) / 6.0428472222
    //        = 0.502357587347...
    // Asserted to 9 decimal places: the reversal is exact algebra, so
    // anything looser would not actually pin the formula down.
    expect(Number(result.margin)).toBeCloseTo(0.502357587347, 9);
    expect(Number(result.marginPercent)).toBeCloseTo(50.2357587347, 7);
    expect(result.belowCost).toBe(false);
  });

  it("round-trips with priceFromMargin", () => {
    const forward = priceFromMargin(TIER_72_143, "0.4");
    if (!forward.ok) throw new Error(forward.message);

    const back = marginFromPrice(TIER_72_143, forward.final);
    if (!back.ok) throw new Error(back.message);

    // The reversal of a rounded-up price is the achieved margin, exactly.
    expect(back.margin).toBe(forward.achievedMargin);
  });

  it("flags a price that does not cover base COGS as below cost", () => {
    const result = marginFromPrice(TIER_72_143, "1.00");
    if (!result.ok) throw new Error(result.message);
    expect(Number(result.margin)).toBeLessThan(0);
    expect(result.belowCost).toBe(true);
  });

  it("returns an inline error, not NaN, when the price equals labor recovery", () => {
    const result = marginFromPrice(TIER_72_143, "0.5071527778");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("at_or_below_labor");
    expect(result.message).toMatch(/\$0\.51 at-cost labor recovery/);
  });

  it("returns an inline error, not Infinity, when the price is below labor recovery", () => {
    const result = marginFromPrice(TIER_72_143, "0.10");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("at_or_below_labor");
  });

  it("rejects a negative price", () => {
    const result = marginFromPrice(TIER_72_143, "-1");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("invalid_price");
  });
});

describe("tierCostKey", () => {
  it("keys a bounded tier by its span", () => {
    expect(tierCostKey(12, 23)).toBe("12:23");
  });

  it("keys the open-ended final tier distinctly from a capped one", () => {
    expect(tierCostKey(2500, null)).toBe("2500:+");
    expect(tierCostKey(2500, null)).not.toBe(tierCostKey(2500, 5000));
  });
});
