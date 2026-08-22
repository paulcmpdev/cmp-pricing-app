import { describe, it, expect } from "vitest";
import { getCatalogEntries, resolveProductCost } from "../catalog";
import catalog from "@/lib/fixtures/product-catalog.json";

describe("catalog data separation", () => {
  it("returns only category, sku, and name -- no cost fields", () => {
    const entries = getCatalogEntries();
    expect(entries.length).toBe(catalog.products.length);

    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(["category", "name", "sku"]);
      // Ensure no cost data leaked
      expect(entry).not.toHaveProperty("productCost");
      expect(entry).not.toHaveProperty("bulkPrice");
      expect(entry).not.toHaveProperty("onlineShopPrice");
    }
  });

  it("resolves a known SKU to its product cost", () => {
    const cost = resolveProductCost("ST400");
    expect(cost).toBe(5.68);
  });

  it("returns undefined for an unknown SKU", () => {
    const cost = resolveProductCost("DOES_NOT_EXIST");
    expect(cost).toBeUndefined();
  });

  it("catalog entries match source product count", () => {
    const entries = getCatalogEntries();
    expect(entries.length).toBe(45);
  });
});
