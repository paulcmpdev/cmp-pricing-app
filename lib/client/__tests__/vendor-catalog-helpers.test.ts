import { describe, expect, it } from "vitest";
import {
  describeVariantAvailability,
  isStaleVendorPricing,
  shouldClearItemQuoteForVendorSelectionChange,
  sortVendorSizeVariants,
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

  it("sorts SanMar apparel sizes smallest to largest despite colliding source orders", () => {
    const variants = [
      { id: "2xl", size: "2XL", sizeOrder: 1 },
      { id: "xs", size: "XS", sizeOrder: 1 },
      { id: "3xl", size: "3XL", sizeOrder: 2 },
      { id: "s", size: "S", sizeOrder: 2 },
      { id: "4xl", size: "4XL", sizeOrder: 3 },
      { id: "m", size: "M", sizeOrder: 3 },
      { id: "l", size: "L", sizeOrder: 4 },
      { id: "xl", size: "XL", sizeOrder: 5 },
    ];

    expect(sortVendorSizeVariants(variants).map((variant) => variant.size)).toEqual([
      "XS",
      "S",
      "M",
      "L",
      "XL",
      "2XL",
      "3XL",
      "4XL",
    ]);
    expect(variants.map((variant) => variant.size)).toEqual([
      "2XL",
      "XS",
      "3XL",
      "S",
      "4XL",
      "M",
      "L",
      "XL",
    ]);
  });

  it("normalizes common apparel aliases and composite sizes", () => {
    const variants = [
      { id: "xxl", size: "XXL", sizeOrder: null },
      { id: "l-xl", size: "L/XL", sizeOrder: null },
      { id: "s-m", size: "S/M", sizeOrder: null },
      { id: "m-l", size: "M/L", sizeOrder: null },
      { id: "yxs", size: "YXS", sizeOrder: null },
    ];

    expect(sortVendorSizeVariants(variants).map((variant) => variant.size)).toEqual([
      "YXS",
      "S/M",
      "M/L",
      "L/XL",
      "XXL",
    ]);
  });

  it("keeps mixed tall sizes in sensible sequence without leapfrogging", () => {
    const variants = [
      { id: "xl", size: "XL", sizeOrder: 3 },
      { id: "lt", size: "LT", sizeOrder: 2 },
      { id: "l", size: "L", sizeOrder: 1 },
      { id: "2xlt", size: "2XLT", sizeOrder: 5 },
      { id: "xlt", size: "XLT", sizeOrder: 4 },
    ];

    expect(sortVendorSizeVariants(variants).map((variant) => variant.size)).toEqual([
      "L",
      "LT",
      "XL",
      "XLT",
      "2XLT",
    ]);
  });

  it("normalizes spaced youth labels and safely handles missing source order", () => {
    const variants = [
      { id: "other", size: "Other", sizeOrder: 2 },
      { id: "custom", size: "Custom" },
      { id: "ys", size: "Youth S", sizeOrder: null },
      { id: "yxs", size: "Youth XS", sizeOrder: null },
    ];

    expect(sortVendorSizeVariants(variants).map((variant) => variant.size)).toEqual([
      "Youth XS",
      "Youth S",
      "Other",
      "Custom",
    ]);
  });

  it("uses source order and natural numeric labels as safe fallbacks", () => {
    const variants = [
      { id: "34", size: "34", sizeOrder: null },
      { id: "30", size: "30", sizeOrder: null },
      { id: "one", size: "One Size", sizeOrder: 2 },
      { id: "custom", size: "Custom", sizeOrder: 1 },
      { id: "unknown", size: null, sizeOrder: null },
    ];

    expect(sortVendorSizeVariants(variants).map((variant) => variant.size)).toEqual([
      "Custom",
      "One Size",
      "30",
      "34",
      null,
    ]);
  });

  it("labels discontinued variants and marks them disabled", () => {
    expect(describeVariantAvailability({ size: "L", discontinued: true })).toEqual({
      optionLabel: "L - discontinued",
      disabled: true,
    });
    expect(describeVariantAvailability({ size: "M", discontinued: false })).toEqual({
      optionLabel: "M",
      disabled: false,
    });
  });
});
