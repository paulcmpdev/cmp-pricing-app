import { describe, expect, it } from "vitest";
import {
  fmtCurrency,
  fmtPercent,
  fmtWholePercent,
  fmtQtyRange,
  fmtDelta,
  fmtDeltaPercent,
  marginWarning,
} from "../pricing-helpers";

describe("fmtCurrency", () => {
  it("formats a number with dollar sign and two decimals", () => {
    expect(fmtCurrency(6.55)).toBe("$6.55");
    expect(fmtCurrency("47.70")).toBe("$47.70");
    expect(fmtCurrency(0)).toBe("$0.00");
    expect(fmtCurrency(2714.4)).toBe("$2,714.40");
  });

  it("returns -- for non-finite values", () => {
    expect(fmtCurrency(NaN)).toBe("--");
    expect(fmtCurrency("not-a-number")).toBe("--");
  });
});

describe("fmtPercent", () => {
  it("converts decimal to percent string", () => {
    expect(fmtPercent(0.5)).toBe("50.0%");
    expect(fmtPercent("0.45")).toBe("45.0%");
    expect(fmtPercent(0.08)).toBe("8.0%");
  });

  it("respects decimals param", () => {
    expect(fmtPercent(0.3456, 2)).toBe("34.56%");
  });

  it("returns -- for NaN", () => {
    expect(fmtPercent("nope")).toBe("--");
  });
});

describe("fmtWholePercent", () => {
  it("rounds to whole percent", () => {
    expect(fmtWholePercent(0.5)).toBe("50%");
    expect(fmtWholePercent("0.35")).toBe("35%");
  });
});

describe("fmtQtyRange", () => {
  it("formats single-qty tiers", () => {
    expect(fmtQtyRange(1, 1)).toBe("1");
    expect(fmtQtyRange(11, 11)).toBe("11");
  });

  it("formats range tiers", () => {
    expect(fmtQtyRange(72, 143)).toBe("72-143");
    expect(fmtQtyRange(1000, 1499)).toBe("1,000-1,499");
  });

  it("formats max-tier with plus", () => {
    expect(fmtQtyRange(2500, 5000)).toBe("2,500+");
  });
});

describe("fmtDelta", () => {
  it("formats positive delta with plus sign", () => {
    expect(fmtDelta(0.5)).toBe("+$0.50");
  });

  it("formats negative delta", () => {
    expect(fmtDelta(-1.25)).toBe("-$1.25");
  });

  it("formats zero", () => {
    expect(fmtDelta(0)).toBe("$0.00");
  });
});

describe("fmtDeltaPercent", () => {
  it("formats positive percent delta", () => {
    expect(fmtDeltaPercent(0.05)).toBe("+5.0%");
  });

  it("formats negative percent delta", () => {
    expect(fmtDeltaPercent(-0.032)).toBe("-3.2%");
  });
});

describe("marginWarning", () => {
  it("warns below 20%", () => {
    expect(marginWarning(19)).toBe("Below 20% - review recommended");
    expect(marginWarning(0)).toBe("Below 20% - review recommended");
  });

  it("warns above 70%", () => {
    expect(marginWarning(71)).toBe("Above 70% - review recommended");
    expect(marginWarning(99)).toBe("Above 70% - review recommended");
  });

  it("returns null for valid range", () => {
    expect(marginWarning(20)).toBeNull();
    expect(marginWarning(50)).toBeNull();
    expect(marginWarning(70)).toBeNull();
  });
});
