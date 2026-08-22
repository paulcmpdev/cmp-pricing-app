import "server-only";

import { existsSync } from "node:fs";
import { openSqliteDatabase, type DatabaseSyncLike } from "./sqlite";

export type VendorCatalogVendor = "all" | "ss" | "sanmar";

export interface VendorCatalogStatus {
  available: boolean;
  reason?: string;
}

export interface VendorCatalogStyleSummary {
  id: string;
  vendor: "ss" | "sanmar";
  styleCode: string;
  brand: string | null;
  name: string | null;
  category: string | null;
  description: string | null;
  imageUrl: string | null;
  activeVariantCount: number;
  sourceSyncAt: string | null;
}

export interface VendorCatalogPublicVariant {
  id: string;
  styleId: string;
  vendor: "ss" | "sanmar";
  styleCode: string;
  color: string | null;
  size: string | null;
  sizeOrder: number | null;
  inventoryQty: number | null;
  imageUrl: string | null;
  discontinued: boolean;
  sourceSyncAt: string | null;
}

export interface CatalogVariantCostResolution {
  variantId: string;
  vendor: "ss" | "sanmar";
  styleId: string;
  styleCode: string;
  color: string | null;
  size: string | null;
  unitCost: number;
  costBasis: string;
  sourceSyncAt: string | null;
}

type StyleRow = {
  id: string;
  vendor: "ss" | "sanmar";
  style_code: string;
  brand: string | null;
  name: string | null;
  category: string | null;
  description: string | null;
  image_url: string | null;
  active_variant_count: number;
  source_sync_at: string | null;
};

type VariantRow = {
  id: string;
  style_id: string;
  vendor: "ss" | "sanmar";
  style_code: string;
  color: string | null;
  size: string | null;
  size_order: number | null;
  inventory_qty: number | null;
  image_url: string | null;
  discontinued: number;
  resolved_cost: number;
  cost_basis: string;
  source_sync_at: string | null;
};

function configuredPath(): string | undefined {
  return process.env.VENDOR_CATALOG_DB_PATH?.trim() || undefined;
}

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T | undefined {
  const path = configuredPath();
  if (!path || !existsSync(path)) return undefined;
  const db = openSqliteDatabase(path, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function getVendorCatalogStatus(): VendorCatalogStatus {
  const path = configuredPath();
  if (!path) {
    return {
      available: false,
      reason: "VENDOR_CATALOG_DB_PATH is not configured.",
    };
  }
  if (!existsSync(path)) {
    return {
      available: false,
      reason: `Vendor catalog database was not found at ${path}.`,
    };
  }
  return { available: true };
}

export function searchVendorCatalogStyles({
  query,
  vendor,
}: {
  query: string;
  vendor: VendorCatalogVendor;
}): VendorCatalogStyleSummary[] {
  const term = query.trim();
  if (term.length < 2) return [];

  const rows = withDb((db) => {
    const vendorClause = vendor === "all" ? "" : "AND vendor = ?";
    return db
      .prepare(
        `
        SELECT id, vendor, style_code, brand, name, category, description,
               image_url, active_variant_count, source_sync_at
        FROM catalog_styles
        WHERE (
          lower(style_code) = lower(?)
          OR lower(style_code) LIKE lower(?)
          OR lower(style_code) LIKE lower(?)
          OR lower(brand) LIKE lower(?)
          OR lower(name) LIKE lower(?)
        )
        ${vendorClause}
        ORDER BY
          CASE
            WHEN lower(style_code) = lower(?) THEN 0
            WHEN lower(style_code) LIKE lower(?) THEN 1
            ELSE 2
          END,
          style_code COLLATE NOCASE,
          name COLLATE NOCASE
        LIMIT ?
        `
      )
      .all(...paramsForSearch(term, vendor)) as StyleRow[];
  });

  return (rows ?? []).map(toPublicStyle);
}

function paramsForSearch(term: string, vendor: VendorCatalogVendor) {
  const contains = `%${term}%`;
  const prefix = `${term}%`;
  const common = [term, prefix, contains, contains, contains];
  return vendor === "all"
    ? [...common, term, prefix, 25]
    : [...common, vendor, term, prefix, 25];
}

export function getVendorCatalogStyleVariants(
  styleId: string
): VendorCatalogPublicVariant[] {
  const rows = withDb((db) =>
    db
      .prepare(
        `
        SELECT id, style_id, vendor, style_code, color, size, size_order,
               inventory_qty, image_url, discontinued, resolved_cost,
               cost_basis, source_sync_at
        FROM catalog_variants
        WHERE style_id = ?
        ORDER BY color COLLATE NOCASE, size_order, size COLLATE NOCASE
        `
      )
      .all(styleId)
  ) as VariantRow[] | undefined;

  return (rows ?? []).map(toPublicVariant);
}

export function resolveCatalogVariantCost(
  variantId: string
): CatalogVariantCostResolution | undefined {
  const row = withDb((db) =>
    db
      .prepare(
        `
        SELECT id, style_id, vendor, style_code, color, size, size_order,
               inventory_qty, image_url, discontinued, resolved_cost,
               cost_basis, source_sync_at
        FROM catalog_variants
        WHERE id = ?
        `
      )
      .get(variantId)
  ) as VariantRow | undefined;

  if (!row) return undefined;
  return {
    variantId: row.id,
    vendor: row.vendor,
    styleId: row.style_id,
    styleCode: row.style_code,
    color: row.color,
    size: row.size,
    unitCost: row.resolved_cost,
    costBasis: row.cost_basis,
    sourceSyncAt: row.source_sync_at,
  };
}

function toPublicStyle(row: StyleRow): VendorCatalogStyleSummary {
  return {
    id: row.id,
    vendor: row.vendor,
    styleCode: row.style_code,
    brand: row.brand,
    name: row.name,
    category: row.category,
    description: row.description,
    imageUrl: row.image_url,
    activeVariantCount: row.active_variant_count,
    sourceSyncAt: row.source_sync_at,
  };
}

function toPublicVariant(row: VariantRow): VendorCatalogPublicVariant {
  return {
    id: row.id,
    styleId: row.style_id,
    vendor: row.vendor,
    styleCode: row.style_code,
    color: row.color,
    size: row.size,
    sizeOrder: row.size_order,
    inventoryQty: row.inventory_qty,
    imageUrl: row.image_url,
    discontinued: Boolean(row.discontinued),
    sourceSyncAt: row.source_sync_at,
  };
}
