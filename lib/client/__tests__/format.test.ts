import { describe, it, expect } from "vitest";
import { formatCurrency, formatPercent } from "../format";

describe("formatCurrency", () => {
  it("formats positive values with $ and two decimals", () => {
    expect(formatCurrency(14.45)).toBe("$14.45");
  });

  it("formats zero", () => {
    expect(formatCurrency(0)).toBe("$0.00");
  });

  it("formats large values with comma grouping", () => {
    expect(formatCurrency(1213.8)).toBe("$1,213.80");
  });

  it("rounds 7.355 to $7.36 using ROUND_HALF_UP", () => {
    expect(formatCurrency(7.355)).toBe("$7.36");
  });

  it("rounds 2.445 to $2.45 using ROUND_HALF_UP", () => {
    expect(formatCurrency(2.445)).toBe("$2.45");
  });

  it("rounds 0.005 to $0.01 using ROUND_HALF_UP", () => {
    expect(formatCurrency(0.005)).toBe("$0.01");
  });

  it("formats negative values", () => {
    expect(formatCurrency(-5.5)).toBe("-$5.50");
  });
});

describe("formatPercent", () => {
  it("converts decimal ratio to percentage string", () => {
    expect(formatPercent(0.509)).toBe("50.9%");
  });

  it("respects custom decimal places", () => {
    expect(formatPercent(0.50931, 2)).toBe("50.93%");
  });

  it("handles zero", () => {
    expect(formatPercent(0)).toBe("0.0%");
  });

  it("handles 100%", () => {
    expect(formatPercent(1)).toBe("100.0%");
  });

  it("rounds 0.5095 to 51.0% with ROUND_HALF_UP", () => {
    expect(formatPercent(0.5095)).toBe("51.0%");
  });
});
