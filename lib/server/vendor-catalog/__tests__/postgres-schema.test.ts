import { describe, expect, it } from "vitest";
import { VENDOR_CATALOG_POSTGRES_SCHEMA_SQL } from "../postgres-schema.mjs";

describe("vendor catalog PostgreSQL schema", () => {
  it("models immutable per-vendor imports and one active pointer per vendor", () => {
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS catalog_imports"
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS active_catalog_versions"
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toMatch(
      /vendor TEXT PRIMARY KEY/
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toMatch(
      /import_id UUID NOT NULL REFERENCES catalog_imports\(id\)/
    );
  });

  it("keeps styles and variants scoped to an immutable import", () => {
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toMatch(
      /PRIMARY KEY \(import_id, id\)/
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toMatch(
      /FOREIGN KEY \(import_id, style_id\)/
    );
  });

  it("stores server-only cost and source freshness fields", () => {
    for (const field of [
      "resolved_cost",
      "cost_basis",
      "source_sync_at",
      "source_status",
      "source_errors",
      "content_hash",
    ]) {
      expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain(field);
    }
  });

  it("supports atomic activation and rejects invalid vendor/status values", () => {
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain(
      "CHECK (vendor IN ('ss', 'sanmar'))"
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain(
      "CHECK (status IN ('building', 'validating', 'ready', 'active', 'rejected', 'superseded'))"
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain(
      "CREATE OR REPLACE VIEW active_catalog_variants"
    );
  });

  it("active views join catalog_imports and filter status=active", () => {
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toMatch(
      /active_catalog_styles[\s\S]*JOIN catalog_imports i[\s\S]*i\.status = 'active'/
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toMatch(
      /active_catalog_variants[\s\S]*JOIN catalog_imports i[\s\S]*i\.status = 'active'/
    );
  });

  it("defines a durable, vendor-scoped rollback audit table and indexes", () => {
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS catalog_rollbacks"
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toMatch(
      /CONSTRAINT catalog_rollbacks_requested_by_check[\s\S]*char_length\(requested_by\) <= 200[\s\S]*requested_by ~ '\[\^\[:space:\]\]'/
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toMatch(
      /CONSTRAINT catalog_rollbacks_reason_check[\s\S]*char_length\(reason\) <= 2000[\s\S]*reason ~ '\[\^\[:space:\]\]'/
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain(
      "CONSTRAINT catalog_rollbacks_imports_distinct_check CHECK (from_import_id <> to_import_id)"
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toMatch(
      /CONSTRAINT catalog_rollbacks_from_import_vendor_fkey[\s\S]*FOREIGN KEY \(from_import_id, vendor\) REFERENCES catalog_imports\(id, vendor\)/
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toMatch(
      /CONSTRAINT catalog_rollbacks_to_import_vendor_fkey[\s\S]*FOREIGN KEY \(to_import_id, vendor\) REFERENCES catalog_imports\(id, vendor\)/
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_catalog_rollbacks_vendor_rolled_back_at[\s\S]*ON catalog_rollbacks\(vendor, rolled_back_at DESC\)/
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain(
      "ON catalog_rollbacks(from_import_id, vendor)"
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain(
      "ON catalog_rollbacks(to_import_id, vendor)"
    );
  });

  it("makes rollback audits append-only and database-timestamped", () => {
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain(
      "CREATE OR REPLACE FUNCTION enforce_catalog_rollbacks_append_only()"
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain(
      "NEW.rolled_back_at := CURRENT_TIMESTAMP"
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain(
      "BEFORE INSERT OR UPDATE OR DELETE ON catalog_rollbacks"
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain(
      "USING ERRCODE = '55000'"
    );
  });

  it("validates existing rollback table and index contracts before accepting them", () => {
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain(
      "catalog_rollbacks schema contract mismatch"
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain(
      "catalog_rollbacks index contract mismatch"
    );
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain("pg_get_constraintdef");
    expect(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL).toContain("pg_get_indexdef");
  });
});
