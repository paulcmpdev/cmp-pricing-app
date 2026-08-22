/**
 * Server-only catalog lookup.
 *
 * Projects product data for the client: only category, SKU, and name.
 * Product cost stays server-side and is resolved by SKU when the API
 * receives a quote request.
 */
import "server-only";
import catalog from "@/lib/fixtures/product-catalog.json";
import type { Product } from "@/lib/pricing/schemas";

export interface CatalogEntry {
  category: string;
  sku: string;
  name: string;
}

const products = catalog.products as Product[];

/** Projected catalog for the browser -- no costs. */
export function getCatalogEntries(): CatalogEntry[] {
  return products.map(({ category, sku, name }) => ({
    category,
    sku,
    name,
  }));
}

/** Resolve a SKU to its product cost. Returns undefined if not found. */
export function resolveProductCost(sku: string): number | undefined {
  const product = products.find((p) => p.sku === sku);
  return product?.productCost;
}
