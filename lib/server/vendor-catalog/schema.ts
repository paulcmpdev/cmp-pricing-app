export const VENDOR_CATALOG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS catalog_sources (
  vendor TEXT PRIMARY KEY CHECK (vendor IN ('ss', 'sanmar')),
  source_sync_at TEXT,
  imported_at TEXT NOT NULL,
  source_status TEXT NOT NULL,
  source_errors INTEGER NOT NULL DEFAULT 0,
  variant_count INTEGER NOT NULL DEFAULT 0,
  style_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS catalog_styles (
  id TEXT PRIMARY KEY,
  vendor TEXT NOT NULL CHECK (vendor IN ('ss', 'sanmar')),
  source_style_id TEXT NOT NULL,
  style_code TEXT NOT NULL,
  brand TEXT,
  name TEXT,
  category TEXT,
  description TEXT,
  image_url TEXT,
  active_variant_count INTEGER NOT NULL DEFAULT 0,
  source_sync_at TEXT
);

CREATE TABLE IF NOT EXISTS catalog_variants (
  id TEXT PRIMARY KEY,
  style_id TEXT NOT NULL REFERENCES catalog_styles(id),
  vendor TEXT NOT NULL CHECK (vendor IN ('ss', 'sanmar')),
  source_variant_id TEXT NOT NULL,
  style_code TEXT NOT NULL,
  color TEXT,
  size TEXT,
  size_order INTEGER,
  inventory_qty INTEGER,
  image_url TEXT,
  discontinued INTEGER NOT NULL DEFAULT 0,
  piece_price REAL,
  dozen_price REAL,
  case_price REAL,
  sale_price REAL,
  customer_price REAL,
  resolved_cost REAL NOT NULL,
  cost_basis TEXT NOT NULL,
  source_sync_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_catalog_styles_vendor ON catalog_styles(vendor);
CREATE INDEX IF NOT EXISTS idx_catalog_styles_style_code ON catalog_styles(style_code);
CREATE INDEX IF NOT EXISTS idx_catalog_styles_brand ON catalog_styles(brand);
CREATE INDEX IF NOT EXISTS idx_catalog_styles_name ON catalog_styles(name);
CREATE INDEX IF NOT EXISTS idx_catalog_variants_style_id ON catalog_variants(style_id);
CREATE INDEX IF NOT EXISTS idx_catalog_variants_vendor ON catalog_variants(vendor);
`;
