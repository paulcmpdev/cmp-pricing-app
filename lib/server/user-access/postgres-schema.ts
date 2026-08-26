/**
 * PostgreSQL schema for the user access control system.
 *
 * Tables:
 *   app_users          - normalized user records with role, status, version
 *   app_user_access_events - append-only audit trail
 *
 * Idempotent: safe to run multiple times via IF NOT EXISTS.
 */

export const USER_ACCESS_SCHEMA_VERSION = 1;

export const USER_ACCESS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_schema_versions (
  component TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 1),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Core user table
CREATE TABLE IF NOT EXISTS app_users (
  email TEXT CONSTRAINT app_users_pkey PRIMARY KEY
    CONSTRAINT app_users_email_check CHECK (email = lower(trim(email)) AND email ~ '^[^@]+@[^@]+$'),
  name TEXT,
  image TEXT,
  role TEXT CONSTRAINT app_users_role_check CHECK (role IS NULL OR role IN ('sales_rep', 'manager', 'admin')),
  status TEXT NOT NULL CONSTRAINT app_users_status_check CHECK (status IN ('pending', 'active', 'disabled')),
  version INTEGER NOT NULL DEFAULT 1 CONSTRAINT app_users_version_check CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_sign_in_at TIMESTAMPTZ,
  CONSTRAINT app_users_status_role_check CHECK (
    (status = 'pending' AND role IS NULL)
    OR (status IN ('active', 'disabled') AND role IS NOT NULL)
  )
);

-- Append-only audit events
CREATE TABLE IF NOT EXISTS app_user_access_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL REFERENCES app_users(email),
  action TEXT NOT NULL CHECK (action IN (
    'access_requested', 'approved', 'role_changed',
    'disabled', 're_enabled', 'pre_authorized'
  )),
  actor_email TEXT NOT NULL,
  before_role TEXT CHECK (before_role IS NULL OR before_role IN ('sales_rep', 'manager', 'admin')),
  after_role TEXT CHECK (after_role IS NULL OR after_role IN ('sales_rep', 'manager', 'admin')),
  before_status TEXT CHECK (before_status IS NULL OR before_status IN ('pending', 'active', 'disabled')),
  after_status TEXT CHECK (after_status IS NULL OR after_status IN ('pending', 'active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_app_users_status_updated
  ON app_users (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_user_access_events_user_email
  ON app_user_access_events (user_email, created_at DESC);

-- Append-only protection: reject UPDATE, DELETE, and TRUNCATE explicitly.
CREATE OR REPLACE FUNCTION reject_app_user_access_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'app_user_access_events is append-only; % is not allowed', TG_OP
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_app_user_access_events_append_only ON app_user_access_events;
CREATE TRIGGER trg_app_user_access_events_append_only
  BEFORE UPDATE OR DELETE ON app_user_access_events
  FOR EACH ROW EXECUTE FUNCTION reject_app_user_access_event_mutation();

DROP TRIGGER IF EXISTS trg_app_user_access_events_prevent_truncate ON app_user_access_events;
CREATE TRIGGER trg_app_user_access_events_prevent_truncate
  BEFORE TRUNCATE ON app_user_access_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_app_user_access_event_mutation();
`;

/**
 * Schema contract verification query.
 * Returns true when both tables and their constraints exist as expected.
 */
export const SCHEMA_CONTRACT_CHECK_SQL = `
SELECT
  to_regclass('app_users') IS NOT NULL AS users_table,
  to_regclass('app_user_access_events') IS NOT NULL AS events_table,
  (SELECT count(*) = 9 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'app_users') AS users_columns,
  (SELECT count(*) = 9 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'app_user_access_events') AS events_columns,
  EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = to_regclass('app_users')
      AND conname = 'app_users_status_role_check') AS state_constraint,
  to_regclass('idx_app_users_status_updated') IS NOT NULL AS users_index,
  to_regclass('idx_app_user_access_events_user_email') IS NOT NULL AS events_index,
  EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = to_regclass('app_user_access_events')
      AND tgname = 'trg_app_user_access_events_append_only' AND NOT tgisinternal) AS append_trigger,
  EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = to_regclass('app_user_access_events')
      AND tgname = 'trg_app_user_access_events_prevent_truncate' AND NOT tgisinternal) AS truncate_trigger;
`;
