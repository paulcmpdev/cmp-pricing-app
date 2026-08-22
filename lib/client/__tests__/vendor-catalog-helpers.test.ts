import { describe, expect, it } from "vitest";
import {
  describeVariantAvailability,
  isStaleVendorPricing,
  shouldClearItemQuoteForVendorSelectionChange,
} from "../vendor-catalog-helpers";

describe("vendor catalog client helpers", () => {
  it("treats vendor pricing snapshots older than 30 days as stale", () => {
    expect(
      isStaleVendorPricing("2026-07-22T00:00:00.000Z", new Date("2026-08-22T00:00:00.000Z"))
    ).toBe(true);
    expect(
      isStaleVendorPricing("2026-07-24T00:00:00.000Z", new Date("2026-08-22T00:00:00.000Z"))
    ).toBe(false);
  });

  it("treats missing or invalid vendor sync timestamps as stale", () => {
    const now = new Date("2026-08-22T00:00:00.000Z");
    expect(isStaleVendorPricing(null, now)).toBe(true);
    expect(isStaleVendorPricing("not-a-date", now)).toBe(true);
  });

  it("clears incompatible item quotes when vendor catalog selection changes", () => {
    expect(shouldClearItemQuoteForVendorSelectionChange("catalog", "vendor")).toBe(true);
    expect(shouldClearItemQuoteForVendorSelectionChange("vendor", "vendor")).toBe(true);
    expect(shouldClearItemQuoteForVendorSelectionChange("manual", "catalog")).toBe(false);
  });

  it("labels discontinued variants and produces a selected warning", () => {
    expect(describeVariantAvailability({ size: "L", discontinued: true })).toEqual({
      optionLabel: "L - discontinued",
      selectedWarning: "Selected vendor variant is discontinued. Confirm availability before quoting.",
    });
    expect(describeVariantAvailability({ size: "M", discontinued: false })).toEqual({
      optionLabel: "M",
      selectedWarning: null,
    });
  });
});
