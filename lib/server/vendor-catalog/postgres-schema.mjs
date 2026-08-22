export const VENDOR_CATALOG_POSTGRES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS catalog_imports (
  id UUID PRIMARY KEY,
  vendor TEXT NOT NULL CHECK (vendor IN ('ss', 'sanmar')),
  status TEXT NOT NULL CHECK (status IN ('building', 'validating', 'ready', 'active', 'rejected', 'superseded')),
  source_started_at TIMESTAMPTZ,
  source_completed_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at TIMESTAMPTZ,
  style_count INTEGER NOT NULL DEFAULT 0 CHECK (style_count >= 0),
  variant_count INTEGER NOT NULL DEFAULT 0 CHECK (variant_count >= 0),
  invalid_price_count INTEGER NOT NULL DEFAULT 0 CHECK (invalid_price_count >= 0),
  source_status TEXT NOT NULL,
  source_errors INTEGER NOT NULL DEFAULT 0 CHECK (source_errors >= 0),
  source_sync_at TIMESTAMPTZ,
  source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_hash TEXT,
  rejection_reason TEXT,
  UNIQUE (id, vendor)
);

CREATE TABLE IF NOT EXISTS catalog_styles (
  import_id UUID NOT NULL REFERENCES catalog_imports(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  vendor TEXT NOT NULL CHECK (vendor IN ('ss', 'sanmar')),
  source_style_id TEXT NOT NULL,
  style_code TEXT NOT NULL,
  brand TEXT,
  name TEXT,
  category TEXT,
  description TEXT,
  image_url TEXT,
  active_variant_count INTEGER NOT NULL DEFAULT 0 CHECK (active_variant_count >= 0),
  source_sync_at TIMESTAMPTZ,
  PRIMARY KEY (import_id, id),
  UNIQUE (import_id, source_style_id),
  FOREIGN KEY (import_id, vendor) REFERENCES catalog_imports(id, vendor) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS catalog_variants (
  import_id UUID NOT NULL REFERENCES catalog_imports(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  style_id TEXT NOT NULL,
  vendor TEXT NOT NULL CHECK (vendor IN ('ss', 'sanmar')),
  source_variant_id TEXT NOT NULL,
  style_code TEXT NOT NULL,
  color TEXT,
  size TEXT,
  size_order INTEGER,
  inventory_qty INTEGER,
  image_url TEXT,
  discontinued BOOLEAN NOT NULL DEFAULT FALSE,
  piece_price NUMERIC(12, 4),
  dozen_price NUMERIC(12, 4),
  case_price NUMERIC(12, 4),
  sale_price NUMERIC(12, 4),
  customer_price NUMERIC(12, 4),
  resolved_cost NUMERIC(12, 4) NOT NULL CHECK (resolved_cost >= 0),
  cost_basis TEXT NOT NULL,
  source_sync_at TIMESTAMPTZ,
  PRIMARY KEY (import_id, id),
  UNIQUE (import_id, source_variant_id),
  FOREIGN KEY (import_id, style_id) REFERENCES catalog_styles(import_id, id) ON DELETE CASCADE,
  FOREIGN KEY (import_id, vendor) REFERENCES catalog_imports(id, vendor) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS active_catalog_versions (
  vendor TEXT PRIMARY KEY CHECK (vendor IN ('ss', 'sanmar')),
  import_id UUID NOT NULL REFERENCES catalog_imports(id),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (vendor, import_id),
  FOREIGN KEY (import_id, vendor) REFERENCES catalog_imports(id, vendor)
);

CREATE INDEX IF NOT EXISTS idx_catalog_imports_vendor_status
  ON catalog_imports(vendor, status, imported_at DESC);
CREATE INDEX IF NOT EXISTS idx_catalog_styles_search
  ON catalog_styles(import_id, vendor, style_code, brand, name);
CREATE INDEX IF NOT EXISTS idx_catalog_variants_style
  ON catalog_variants(import_id, style_id, color, size_order, size);
CREATE INDEX IF NOT EXISTS idx_catalog_variants_identity
  ON catalog_variants(import_id, id);

CREATE OR REPLACE VIEW active_catalog_styles AS
SELECT s.*
FROM catalog_styles s
JOIN active_catalog_versions a
  ON a.vendor = s.vendor AND a.import_id = s.import_id
JOIN catalog_imports i
  ON i.id = a.import_id AND i.status = 'active';

CREATE OR REPLACE VIEW active_catalog_variants AS
SELECT v.*
FROM catalog_variants v
JOIN active_catalog_versions a
  ON a.vendor = v.vendor AND a.import_id = v.import_id
JOIN catalog_imports i
  ON i.id = a.import_id AND i.status = 'active';
`;
