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
});
