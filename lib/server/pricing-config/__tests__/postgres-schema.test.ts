import { describe, it, expect } from "vitest";
import {
  PRICING_CONFIG_SCHEMA_VERSION,
  PRICING_CONFIG_SCHEMA_SQL,
  PRICING_CONFIG_CONTRACT_CHECK_SQL,
} from "../postgres-schema.mjs";

describe("pricing config postgres schema", () => {
  it("exports a positive schema version", () => {
    expect(PRICING_CONFIG_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("schema SQL is a non-empty string", () => {
    expect(typeof PRICING_CONFIG_SCHEMA_SQL).toBe("string");
    expect(PRICING_CONFIG_SCHEMA_SQL.length).toBeGreaterThan(100);
  });

  it("schema SQL creates pricing_config_versions table", () => {
    expect(PRICING_CONFIG_SCHEMA_SQL).toContain("pricing_config_versions");
  });

  it("schema SQL creates pricing_config_active table", () => {
    expect(PRICING_CONFIG_SCHEMA_SQL).toContain("pricing_config_active");
  });

  it("schema SQL creates pricing_config_events table", () => {
    expect(PRICING_CONFIG_SCHEMA_SQL).toContain("pricing_config_events");
  });

  it("schema SQL creates append-only trigger", () => {
    expect(PRICING_CONFIG_SCHEMA_SQL).toContain("trg_pricing_config_events_append_only");
    expect(PRICING_CONFIG_SCHEMA_SQL).toContain("trg_pricing_config_events_prevent_truncate");
  });

  it("schema SQL enforces status-timestamp constraint", () => {
    expect(PRICING_CONFIG_SCHEMA_SQL).toContain("pricing_config_versions_status_timestamps");
  });

  it("schema SQL creates a versions immutability trigger that blocks delete and snapshot mutation", () => {
    expect(PRICING_CONFIG_SCHEMA_SQL).toContain("trg_pricing_config_versions_immutable");
    expect(PRICING_CONFIG_SCHEMA_SQL).toContain("reject_pricing_config_version_mutation");
    expect(PRICING_CONFIG_SCHEMA_SQL).toContain("BEFORE UPDATE OR DELETE ON pricing_config_versions");
    // Allows the one valid lifecycle transition while rejecting everything else.
    expect(PRICING_CONFIG_SCHEMA_SQL).toContain("OLD.status = 'active' AND NEW.status = 'superseded'");
  });

  it("schema SQL treats activated_at as immutable alongside data/creator/created_at", () => {
    expect(PRICING_CONFIG_SCHEMA_SQL).toContain("NEW.activated_at IS DISTINCT FROM OLD.activated_at");
  });

  it("schema SQL requires the active->superseded transition to set superseded_at exactly once", () => {
    expect(PRICING_CONFIG_SCHEMA_SQL).toContain(
      "OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL"
    );
  });

  it("schema SQL rejects rewriting superseded_at outside of a status transition (no history rewrites)", () => {
    expect(PRICING_CONFIG_SCHEMA_SQL).toContain(
      "ELSIF NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN"
    );
    expect(PRICING_CONFIG_SCHEMA_SQL).toContain("superseded_at cannot be rewritten once set");
  });

  it("schema SQL requires superseded_at to be set once a version is superseded", () => {
    expect(PRICING_CONFIG_SCHEMA_SQL).toContain(
      "status = 'superseded' AND activated_at IS NOT NULL AND superseded_at IS NOT NULL"
    );
  });

  it("schema SQL records a distinct source_version_id for rollback audit events", () => {
    expect(PRICING_CONFIG_SCHEMA_SQL).toContain("source_version_id");
  });

  it("contract check SQL validates expected tables and columns", () => {
    expect(typeof PRICING_CONFIG_CONTRACT_CHECK_SQL).toBe("string");
    expect(PRICING_CONFIG_CONTRACT_CHECK_SQL).toContain("versions_table");
    expect(PRICING_CONFIG_CONTRACT_CHECK_SQL).toContain("active_table");
    expect(PRICING_CONFIG_CONTRACT_CHECK_SQL).toContain("events_table");
    expect(PRICING_CONFIG_CONTRACT_CHECK_SQL).toContain("status_constraint");
    expect(PRICING_CONFIG_CONTRACT_CHECK_SQL).toContain("append_trigger");
    expect(PRICING_CONFIG_CONTRACT_CHECK_SQL).toContain("versions_immutable_trigger");
  });

  it("migration is idempotent (uses IF NOT EXISTS)", () => {
    const ifNotExistsClauses = PRICING_CONFIG_SCHEMA_SQL.match(
      /IF NOT EXISTS/gi
    );
    expect(ifNotExistsClauses).not.toBeNull();
    expect(ifNotExistsClauses!.length).toBeGreaterThanOrEqual(3);
  });
});
