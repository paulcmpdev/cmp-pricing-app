/**
 * PostgreSQL schema for versioned pricing configuration (ESM export for scripts).
 */

export const PRICING_CONFIG_SCHEMA_VERSION = 1;

export const PRICING_CONFIG_SCHEMA_SQL = `
-- Reuse existing app_schema_versions table (created by user-access migration)
CREATE TABLE IF NOT EXISTS app_schema_versions (
  component TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 1),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Immutable version snapshots
CREATE TABLE IF NOT EXISTS pricing_config_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_type TEXT NOT NULL CHECK (config_type IN ('dtf_matrix', 'additional_prints')),
  data JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  created_by TEXT NOT NULL
    CHECK (char_length(created_by) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  CONSTRAINT pricing_config_versions_status_timestamps CHECK (
    (status = 'active' AND activated_at IS NOT NULL AND superseded_at IS NULL)
    OR (status = 'superseded' AND activated_at IS NOT NULL AND superseded_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pricing_config_versions_type_status
  ON pricing_config_versions (config_type, status);

CREATE INDEX IF NOT EXISTS idx_pricing_config_versions_type_created
  ON pricing_config_versions (config_type, created_at DESC);

-- Immutability: snapshot data, creator, creation time, and activation time
-- can never change; rows can never be deleted; status may only transition
-- active -> superseded exactly once, setting superseded_at at that moment;
-- superseded_at can never be rewritten afterward (no history rewrites).
CREATE OR REPLACE FUNCTION reject_pricing_config_version_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pricing_config_versions rows are immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.config_type IS DISTINCT FROM OLD.config_type
    OR NEW.data IS DISTINCT FROM OLD.data
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
  THEN
    RAISE EXCEPTION 'pricing_config_versions snapshot, creator, creation time, and activation time are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (OLD.status = 'active' AND NEW.status = 'superseded') THEN
      RAISE EXCEPTION 'pricing_config_versions status may only transition from active to superseded'
        USING ERRCODE = '55000';
    END IF;

    IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL THEN
      RAISE EXCEPTION 'pricing_config_versions active-to-superseded transition must set superseded_at exactly once'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'pricing_config_versions superseded_at cannot be rewritten once set'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pricing_config_versions_immutable ON pricing_config_versions;
CREATE TRIGGER trg_pricing_config_versions_immutable
  BEFORE UPDATE OR DELETE ON pricing_config_versions
  FOR EACH ROW EXECUTE FUNCTION reject_pricing_config_version_mutation();

-- Active version pointer (one per config_type)
CREATE TABLE IF NOT EXISTS pricing_config_active (
  config_type TEXT PRIMARY KEY CHECK (config_type IN ('dtf_matrix', 'additional_prints')),
  version_id UUID NOT NULL REFERENCES pricing_config_versions(id),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_by TEXT NOT NULL
    CHECK (char_length(activated_by) BETWEEN 1 AND 200)
);

-- Append-only audit events
CREATE TABLE IF NOT EXISTS pricing_config_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_type TEXT NOT NULL CHECK (config_type IN ('dtf_matrix', 'additional_prints')),
  action TEXT NOT NULL CHECK (action IN ('created', 'activated', 'rollback')),
  actor_email TEXT NOT NULL
    CHECK (char_length(actor_email) BETWEEN 1 AND 200),
  prior_version_id UUID REFERENCES pricing_config_versions(id),
  new_version_id UUID NOT NULL REFERENCES pricing_config_versions(id),
  -- The historical version an admin requested to restore on rollback.
  -- Distinct from prior_version_id (the version being superseded) and
  -- new_version_id (the freshly created immutable copy).
  source_version_id UUID REFERENCES pricing_config_versions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pricing_config_events_type_created
  ON pricing_config_events (config_type, created_at DESC);

-- Append-only protection on events
CREATE OR REPLACE FUNCTION reject_pricing_config_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'pricing_config_events is append-only; % is not allowed', TG_OP
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_pricing_config_events_append_only ON pricing_config_events;
CREATE TRIGGER trg_pricing_config_events_append_only
  BEFORE UPDATE OR DELETE ON pricing_config_events
  FOR EACH ROW EXECUTE FUNCTION reject_pricing_config_event_mutation();

DROP TRIGGER IF EXISTS trg_pricing_config_events_prevent_truncate ON pricing_config_events;
CREATE TRIGGER trg_pricing_config_events_prevent_truncate
  BEFORE TRUNCATE ON pricing_config_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_pricing_config_event_mutation();
`;

export const PRICING_CONFIG_CONTRACT_CHECK_SQL = `
SELECT
  to_regclass('pricing_config_versions') IS NOT NULL AS versions_table,
  to_regclass('pricing_config_active') IS NOT NULL AS active_table,
  to_regclass('pricing_config_events') IS NOT NULL AS events_table,
  (SELECT count(*) = 8 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'pricing_config_versions') AS versions_columns,
  (SELECT count(*) = 4 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'pricing_config_active') AS active_columns,
  (SELECT count(*) = 8 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'pricing_config_events') AS events_columns,
  EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = to_regclass('pricing_config_versions')
      AND conname = 'pricing_config_versions_status_timestamps') AS status_constraint,
  EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = to_regclass('pricing_config_events')
      AND tgname = 'trg_pricing_config_events_append_only' AND NOT tgisinternal) AS append_trigger,
  EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = to_regclass('pricing_config_events')
      AND tgname = 'trg_pricing_config_events_prevent_truncate' AND NOT tgisinternal) AS truncate_trigger,
  EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = to_regclass('pricing_config_versions')
      AND tgname = 'trg_pricing_config_versions_immutable' AND NOT tgisinternal) AS versions_immutable_trigger;
`;
