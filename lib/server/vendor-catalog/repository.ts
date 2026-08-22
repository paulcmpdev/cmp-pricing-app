import "server-only";

import { existsSync } from "node:fs";
import { Pool } from "pg";
import { openSqliteDatabase, type DatabaseSyncLike } from "./sqlite";
import { createPostgresVendorCatalogRepository } from "./postgres-repository";

export type VendorCatalogVendor = "all" | "ss" | "sanmar";

export interface VendorCatalogStatus {
  available: boolean;
  backend?: "postgres" | "sqlite";
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

type PublicVariantRow = {
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
  source_sync_at: string | null;
};

type VariantRow = PublicVariantRow & {
  resolved_cost: number;
  cost_basis: string;
};

let postgresPool: Pool | undefined;
let postgresPoolUrl: string | undefined;

function configuredSqlitePath(): string | undefined {
  return process.env.VENDOR_CATALOG_DB_PATH?.trim() || undefined;
}

function configuredPostgresUrl(): string | undefined {
  return process.env.VENDOR_CATALOG_DATABASE_URL?.trim() || undefined;
}

function withSqliteDb<T>(fn: (db: DatabaseSyncLike) => T): T | undefined {
  const path = configuredSqlitePath();
  if (!path || !existsSync(path)) return undefined;
  const db = openSqliteDatabase(path, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function getPostgresPool(): Pool {
  const url = configuredPostgresUrl();
  if (!url) throw new Error("VENDOR_CATALOG_DATABASE_URL is not configured.");
  if (!postgresPool || postgresPoolUrl !== url) {
    void postgresPool?.end();
    // Use a pooled/transaction URL from your PG provider (e.g. Supabase pgbouncer
    // port 6543) to avoid exhausting direct connections on Vercel serverless.
    postgresPool = new Pool({
      connectionString: url,
      max: 2,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    postgresPoolUrl = url;
  }
  return postgresPool;
}

function getPostgresRepository() {
  const pool = getPostgresPool();
  return createPostgresVendorCatalogRepository({
    async query(text, values) {
      const result = await pool.query(text, values);
      return { rows: result.rows };
    },
  });
}

export async function getVendorCatalogStatus(): Promise<VendorCatalogStatus> {
  if (configuredPostgresUrl()) {
    try {
      // Require BOTH ss AND sanmar active with status='active' in catalog_imports
      const result = await getPostgresPool().query(
        `SELECT a.vendor
         FROM active_catalog_versions a
         JOIN catalog_imports i ON i.id = a.import_id AND i.status = 'active'`
      );
      const activeVendors = new Set(
        result.rows.map((row: { vendor: string }) => row.vendor)
      );
      if (!activeVendors.has("ss") || !activeVendors.has("sanmar")) {
        const missing = ["ss", "sanmar"].filter((v) => !activeVendors.has(v));
        return {
          available: false,
          backend: "postgres",
          reason: `Missing active vendor catalog for: ${missing.join(", ")}.`,
        };
      }
      return { available: true, backend: "postgres" };
    } catch {
      return {
        available: false,
        backend: "postgres",
        reason: "The PostgreSQL vendor catalog could not be reached.",
      };
    }
  }

  const path = configuredSqlitePath();
  if (!path) {
    return {
      available: false,
      reason:
        "Neither VENDOR_CATALOG_DATABASE_URL nor VENDOR_CATALOG_DB_PATH is configured.",
    };
  }
  if (!existsSync(path)) {
    return {
      available: false,
      backend: "sqlite",
      reason: `Vendor catalog database was not found at ${path}.`,
    };
  }
  return { available: true, backend: "sqlite" };
}

export async function searchVendorCatalogStyles({
  query,
  vendor,
}: {
  query: string;
  vendor: VendorCatalogVendor;
}): Promise<VendorCatalogStyleSummary[]> {
  if (configuredPostgresUrl()) {
    return getPostgresRepository().searchStyles({ query, vendor });
  }

  const term = query.trim();
  if (term.length < 2) return [];
  const rows = withSqliteDb((db) => {
    const vendorClause = vendor === "all" ? "" : "AND vendor = ?";
    return db
      .prepare(
        `SELECT id, vendor, style_code, brand, name, category, description,
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
           style_code COLLATE NOCASE, name COLLATE NOCASE
         LIMIT ?`
      )
      .all(...paramsForSqliteSearch(term, vendor)) as StyleRow[];
  });
  return (rows ?? []).map(toPublicStyle);
}

export async function getVendorCatalogStyleVariants(
  styleId: string
): Promise<VendorCatalogPublicVariant[]> {
  if (configuredPostgresUrl()) {
    return getPostgresRepository().getStyleVariants(styleId);
  }
  const rows = withSqliteDb((db) =>
    db
      .prepare(
        `SELECT id, style_id, vendor, style_code, color, size, size_order,
                inventory_qty, image_url, discontinued, source_sync_at
         FROM catalog_variants
         WHERE style_id = ?
         ORDER BY color COLLATE NOCASE, size_order, size COLLATE NOCASE`
      )
      .all(styleId)
  ) as PublicVariantRow[] | undefined;
  return (rows ?? []).map(toPublicVariant);
}

export async function resolveCatalogVariantCost(
  variantId: string
): Promise<CatalogVariantCostResolution | undefined> {
  if (configuredPostgresUrl()) {
    return getPostgresRepository().resolveVariantCost(variantId);
  }
  const row = withSqliteDb((db) =>
    db
      .prepare(
        `SELECT id, style_id, vendor, style_code, color, size, size_order,
                inventory_qty, image_url, discontinued, resolved_cost,
                cost_basis, source_sync_at
         FROM catalog_variants WHERE id = ?`
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
    unitCost: Number(row.resolved_cost),
    costBasis: row.cost_basis,
    sourceSyncAt: row.source_sync_at,
  };
}

export async function closeVendorCatalogPoolForTests(): Promise<void> {
  if (postgresPool) await postgresPool.end();
  postgresPool = undefined;
  postgresPoolUrl = undefined;
}

function paramsForSqliteSearch(term: string, vendor: VendorCatalogVendor) {
  const contains = `%${term}%`;
  const prefix = `${term}%`;
  const common = [term, prefix, contains, contains, contains];
  return vendor === "all"
    ? [...common, term, prefix, 25]
    : [...common, vendor, term, prefix, 25];
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
    activeVariantCount: Number(row.active_variant_count),
    sourceSyncAt: row.source_sync_at,
  };
}

function toPublicVariant(row: PublicVariantRow): VendorCatalogPublicVariant {
  return {
    id: row.id,
    styleId: row.style_id,
    vendor: row.vendor,
    styleCode: row.style_code,
    color: row.color,
    size: row.size,
    sizeOrder: row.size_order == null ? null : Number(row.size_order),
    inventoryQty: row.inventory_qty == null ? null : Number(row.inventory_qty),
    imageUrl: row.image_url,
    discontinued: Boolean(row.discontinued),
    sourceSyncAt: row.source_sync_at,
  };
}
