import "server-only";

import type {
  CatalogVariantCostResolution,
  VendorCatalogPublicVariant,
  VendorCatalogStyleSummary,
  VendorCatalogVendor,
} from "./repository";

type QueryResult = { rows: Record<string, unknown>[] };
export interface PostgresQueryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

type Vendor = "ss" | "sanmar";

export function createPostgresVendorCatalogRepository(database: PostgresQueryable) {
  return {
    async searchStyles({
      query,
      vendor,
    }: {
      query: string;
      vendor: VendorCatalogVendor;
    }): Promise<VendorCatalogStyleSummary[]> {
      const term = query.trim();
      if (term.length < 2) return [];
      const escaped = escapeLike(term);
      const result = await database.query(
        `SELECT id, vendor, style_code, brand, name, category, description,
                image_url, active_variant_count, source_sync_at
         FROM active_catalog_styles
         WHERE (
           lower(style_code) = lower($1)
           OR style_code ILIKE $2 ESCAPE '\\'
           OR style_code ILIKE $3 ESCAPE '\\'
           OR brand ILIKE $3 ESCAPE '\\'
           OR name ILIKE $3 ESCAPE '\\'
         )
         AND ($4 = 'all' OR vendor = $4)
         ORDER BY
           CASE
             WHEN lower(style_code) = lower($1) THEN 0
             WHEN style_code ILIKE $2 ESCAPE '\\' THEN 1
             ELSE 2
           END,
           lower(style_code), lower(COALESCE(name, ''))
         LIMIT 25`,
        [term, `${escaped}%`, `%${escaped}%`, vendor]
      );
      return result.rows.map(toPublicStyle);
    },

    async getStyleVariants(styleId: string): Promise<VendorCatalogPublicVariant[]> {
      const result = await database.query(
        `SELECT id, style_id, vendor, style_code, color, size, size_order,
                inventory_qty, image_url, discontinued, source_sync_at
         FROM active_catalog_variants
         WHERE style_id = $1
         ORDER BY lower(COALESCE(color, '')), size_order NULLS LAST,
                  lower(COALESCE(size, ''))`,
        [styleId]
      );
      return result.rows.map(toPublicVariant);
    },

    async resolveVariantCost(
      variantId: string
    ): Promise<CatalogVariantCostResolution | undefined> {
      const result = await database.query(
        `SELECT id, style_id, vendor, style_code, color, size,
                resolved_cost, cost_basis, source_sync_at
         FROM active_catalog_variants
         WHERE id = $1
         LIMIT 1`,
        [variantId]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        variantId: String(row.id),
        vendor: asVendor(row.vendor),
        styleId: String(row.style_id),
        styleCode: String(row.style_code),
        color: nullableString(row.color),
        size: nullableString(row.size),
        unitCost: Number(row.resolved_cost),
        costBasis: String(row.cost_basis),
        sourceSyncAt: timestamp(row.source_sync_at),
      };
    },
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function asVendor(value: unknown): Vendor {
  if (value === "ss" || value === "sanmar") return value;
  throw new Error(`Unexpected vendor value: ${String(value)}`);
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function timestamp(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("Invalid catalog timestamp.");
  return date.toISOString();
}

function toPublicStyle(row: Record<string, unknown>): VendorCatalogStyleSummary {
  return {
    id: String(row.id),
    vendor: asVendor(row.vendor),
    styleCode: String(row.style_code),
    brand: nullableString(row.brand),
    name: nullableString(row.name),
    category: nullableString(row.category),
    description: nullableString(row.description),
    imageUrl: nullableString(row.image_url),
    activeVariantCount: Number(row.active_variant_count),
    sourceSyncAt: timestamp(row.source_sync_at),
  };
}

function toPublicVariant(row: Record<string, unknown>): VendorCatalogPublicVariant {
  return {
    id: String(row.id),
    styleId: String(row.style_id),
    vendor: asVendor(row.vendor),
    styleCode: String(row.style_code),
    color: nullableString(row.color),
    size: nullableString(row.size),
    sizeOrder: row.size_order == null ? null : Number(row.size_order),
    inventoryQty: row.inventory_qty == null ? null : Number(row.inventory_qty),
    imageUrl: nullableString(row.image_url),
    discontinued: Boolean(row.discontinued),
    sourceSyncAt: timestamp(row.source_sync_at),
  };
}
