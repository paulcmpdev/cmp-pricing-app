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

CREATE TABLE IF NOT EXISTS catalog_rollbacks (
  id UUID CONSTRAINT catalog_rollbacks_pkey PRIMARY KEY,
  vendor TEXT NOT NULL CONSTRAINT catalog_rollbacks_vendor_check CHECK (vendor IN ('ss', 'sanmar')),
  from_import_id UUID NOT NULL,
  to_import_id UUID NOT NULL,
  requested_by TEXT NOT NULL
    CONSTRAINT catalog_rollbacks_requested_by_check
    CHECK (char_length(requested_by) <= 200 AND requested_by ~ '[^[:space:]]'),
  reason TEXT NOT NULL
    CONSTRAINT catalog_rollbacks_reason_check
    CHECK (char_length(reason) <= 2000 AND reason ~ '[^[:space:]]'),
  rolled_back_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT catalog_rollbacks_imports_distinct_check CHECK (from_import_id <> to_import_id),
  CONSTRAINT catalog_rollbacks_from_import_vendor_fkey
    FOREIGN KEY (from_import_id, vendor) REFERENCES catalog_imports(id, vendor),
  CONSTRAINT catalog_rollbacks_to_import_vendor_fkey
    FOREIGN KEY (to_import_id, vendor) REFERENCES catalog_imports(id, vendor)
);

DO $$
DECLARE
  rollback_table REGCLASS := to_regclass('catalog_rollbacks');
  actual_columns JSONB;
BEGIN
  IF rollback_table IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = rollback_table AND relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'catalog_rollbacks schema contract mismatch: expected a regular table';
  END IF;

  SELECT jsonb_agg(
           jsonb_build_array(column_name, data_type, is_nullable, column_default)
           ORDER BY ordinal_position
         )
    INTO actual_columns
    FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND table_name = 'catalog_rollbacks';

  IF actual_columns IS DISTINCT FROM
    '[
      ["id", "uuid", "NO", null],
      ["vendor", "text", "NO", null],
      ["from_import_id", "uuid", "NO", null],
      ["to_import_id", "uuid", "NO", null],
      ["requested_by", "text", "NO", null],
      ["reason", "text", "NO", null],
      ["rolled_back_at", "timestamp with time zone", "NO", "CURRENT_TIMESTAMP"]
    ]'::jsonb
  THEN
    RAISE EXCEPTION 'catalog_rollbacks schema contract mismatch: columns differ';
  END IF;

  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = rollback_table) <> 7
     OR EXISTS (
       WITH expected(conname, contype, definition) AS (
         VALUES
           ('catalog_rollbacks_pkey', 'p', 'PRIMARY KEY (id)'),
           ('catalog_rollbacks_vendor_check', 'c',
            'CHECK (vendor = ANY (ARRAY[''ss''::text, ''sanmar''::text]))'),
           ('catalog_rollbacks_requested_by_check', 'c',
            'CHECK (char_length(requested_by) <= 200 AND requested_by ~ ''[^[:space:]]''::text)'),
           ('catalog_rollbacks_reason_check', 'c',
            'CHECK (char_length(reason) <= 2000 AND reason ~ ''[^[:space:]]''::text)'),
           ('catalog_rollbacks_imports_distinct_check', 'c',
            'CHECK (from_import_id <> to_import_id)'),
           ('catalog_rollbacks_from_import_vendor_fkey', 'f',
            'FOREIGN KEY (from_import_id, vendor) REFERENCES catalog_imports(id, vendor)'),
           ('catalog_rollbacks_to_import_vendor_fkey', 'f',
            'FOREIGN KEY (to_import_id, vendor) REFERENCES catalog_imports(id, vendor)')
       )
       SELECT 1
         FROM expected e
         LEFT JOIN pg_constraint c
           ON c.conrelid = rollback_table AND c.conname = e.conname
        WHERE c.oid IS NULL
           OR c.contype <> e.contype::"char"
           OR pg_get_constraintdef(c.oid, true) <> e.definition
     )
  THEN
    RAISE EXCEPTION 'catalog_rollbacks schema contract mismatch: constraints differ';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_catalog_rollbacks_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.rolled_back_at := CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'catalog_rollbacks is append-only; % is not allowed', TG_OP
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_catalog_rollbacks_append_only ON catalog_rollbacks;
CREATE TRIGGER trg_catalog_rollbacks_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON catalog_rollbacks
  FOR EACH ROW EXECUTE FUNCTION enforce_catalog_rollbacks_append_only();

-- Guards against application/operator mistakes, not a hostile table owner who can alter schema objects.
DROP TRIGGER IF EXISTS trg_catalog_rollbacks_prevent_truncate ON catalog_rollbacks;
CREATE TRIGGER trg_catalog_rollbacks_prevent_truncate
  BEFORE TRUNCATE ON catalog_rollbacks
  FOR EACH STATEMENT EXECUTE FUNCTION enforce_catalog_rollbacks_append_only();

CREATE INDEX IF NOT EXISTS idx_catalog_rollbacks_vendor_rolled_back_at
  ON catalog_rollbacks(vendor, rolled_back_at DESC);
CREATE INDEX IF NOT EXISTS idx_catalog_rollbacks_from_import_vendor
  ON catalog_rollbacks(from_import_id, vendor);
CREATE INDEX IF NOT EXISTS idx_catalog_rollbacks_to_import_vendor
  ON catalog_rollbacks(to_import_id, vendor);

DO $$
DECLARE
  rollback_table REGCLASS := to_regclass('catalog_rollbacks');
  expected_name TEXT;
  first_column TEXT;
  second_column TEXT;
  expected_options TEXT;
  index_oid REGCLASS;
BEGIN
  FOR expected_name, first_column, second_column, expected_options IN
    VALUES
      ('idx_catalog_rollbacks_vendor_rolled_back_at', 'vendor', 'rolled_back_at', '0 3'),
      ('idx_catalog_rollbacks_from_import_vendor', 'from_import_id', 'vendor', '0 0'),
      ('idx_catalog_rollbacks_to_import_vendor', 'to_import_id', 'vendor', '0 0')
  LOOP
    index_oid := to_regclass(expected_name);

    IF index_oid IS NULL OR NOT EXISTS (
      SELECT 1
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_am am ON am.oid = i.relam
       WHERE x.indexrelid = index_oid
         AND x.indrelid = rollback_table
         AND am.amname = 'btree'
         AND x.indnkeyatts = 2
         AND x.indnatts = 2
         AND NOT x.indisunique
         AND NOT x.indisprimary
         AND NOT x.indisexclusion
         AND x.indisvalid
         AND x.indisready
         AND x.indpred IS NULL
         AND x.indexprs IS NULL
         AND x.indoption::text = expected_options
         AND pg_get_indexdef(x.indexrelid, 1, true) = first_column
         AND pg_get_indexdef(x.indexrelid, 2, true) = second_column
    ) THEN
      RAISE EXCEPTION 'catalog_rollbacks index contract mismatch: % differs', expected_name;
    END IF;
  END LOOP;
END;
$$;

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

CREATE TABLE IF NOT EXISTS catalog_ingestion_jobs (
  id UUID PRIMARY KEY,
  vendor TEXT NOT NULL CHECK (vendor IN ('ss', 'sanmar')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'validating', 'completed', 'rejected', 'canceled')),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_summary TEXT,
  import_id UUID REFERENCES catalog_imports(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_vendor_status
  ON catalog_ingestion_jobs(vendor, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ingestion_jobs_one_active_per_vendor
  ON catalog_ingestion_jobs(vendor)
  WHERE status IN ('queued', 'running', 'validating');
`;
