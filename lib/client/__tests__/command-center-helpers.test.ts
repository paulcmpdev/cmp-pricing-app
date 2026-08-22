import { describe, it, expect } from "vitest";
import {
  classifyMargin,
  marginBarWidth,
  computeOrderSummary,
  isHighVolume,
  parsePositiveInt,
  parseNonNegativeFloat,
} from "../command-center-helpers";

describe("classifyMargin", () => {
  it("returns healthy for margins >= 0.4", () => {
    expect(classifyMargin(0.4)).toBe("healthy");
    expect(classifyMargin(0.75)).toBe("healthy");
    expect(classifyMargin(1.0)).toBe("healthy");
  });

  it("returns moderate for margins 0.2–0.399", () => {
    expect(classifyMargin(0.2)).toBe("moderate");
    expect(classifyMargin(0.35)).toBe("moderate");
  });

  it("returns thin for margins 0–0.199", () => {
    expect(classifyMargin(0)).toBe("thin");
    expect(classifyMargin(0.19)).toBe("thin");
  });

  it("returns negative for margins below 0", () => {
    expect(classifyMargin(-0.05)).toBe("negative");
    expect(classifyMargin(-1)).toBe("negative");
  });
});

describe("marginBarWidth", () => {
  it("clamps to 0–100", () => {
    expect(marginBarWidth(-0.1)).toBe(0);
    expect(marginBarWidth(0)).toBe(0);
    expect(marginBarWidth(0.5)).toBe(50);
    expect(marginBarWidth(1.0)).toBe(100);
    expect(marginBarWidth(1.5)).toBe(100);
  });

  it("rounds to nearest integer", () => {
    expect(marginBarWidth(0.456)).toBe(46);
    expect(marginBarWidth(0.555)).toBe(56);
  });
});

describe("computeOrderSummary", () => {
  it("sums item and add-on totals", () => {
    const result = computeOrderSummary(1000, 200);
    expect(result.grandTotal).toBe(1200);
    expect(result.hasAddOn).toBe(true);
  });

  it("handles null item total", () => {
    const result = computeOrderSummary(null, 200);
    expect(result.grandTotal).toBe(200);
  });

  it("handles null add-on total", () => {
    const result = computeOrderSummary(1000, null);
    expect(result.grandTotal).toBe(1000);
    expect(result.hasAddOn).toBe(false);
  });

  it("handles both null", () => {
    const result = computeOrderSummary(null, null);
    expect(result.grandTotal).toBe(0);
    expect(result.hasAddOn).toBe(false);
  });

  it("treats zero add-on as no add-on", () => {
    const result = computeOrderSummary(500, 0);
    expect(result.hasAddOn).toBe(false);
  });
});

describe("isHighVolume", () => {
  it("returns true for quantities over 5000", () => {
    expect(isHighVolume(5001)).toBe(true);
    expect(isHighVolume(10000)).toBe(true);
  });

  it("returns false for quantities at or below 5000", () => {
    expect(isHighVolume(5000)).toBe(false);
    expect(isHighVolume(1)).toBe(false);
  });

  it("returns false for non-finite values", () => {
    expect(isHighVolume(NaN)).toBe(false);
    expect(isHighVolume(Infinity)).toBe(false);
  });
});

describe("parsePositiveInt", () => {
  it("parses valid positive integers", () => {
    expect(parsePositiveInt("84")).toBe(84);
    expect(parsePositiveInt("1")).toBe(1);
  });

  it("returns null for zero and negative", () => {
    expect(parsePositiveInt("0")).toBeNull();
    expect(parsePositiveInt("-5")).toBeNull();
  });

  it("returns null for non-numeric strings", () => {
    expect(parsePositiveInt("")).toBeNull();
    expect(parsePositiveInt("abc")).toBeNull();
  });

  it("rejects decimal strings", () => {
    expect(parsePositiveInt("3.7")).toBeNull();
  });
});

describe("parseNonNegativeFloat", () => {
  it("parses valid non-negative floats", () => {
    expect(parseNonNegativeFloat("3.95")).toBe(3.95);
    expect(parseNonNegativeFloat("0")).toBe(0);
  });

  it("returns null for negative values", () => {
    expect(parseNonNegativeFloat("-1")).toBeNull();
  });

  it("returns null for non-numeric strings", () => {
    expect(parseNonNegativeFloat("")).toBeNull();
    expect(parseNonNegativeFloat("abc")).toBeNull();
  });
});
