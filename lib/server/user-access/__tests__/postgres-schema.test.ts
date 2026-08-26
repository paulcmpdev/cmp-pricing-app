import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { USER_ACCESS_SCHEMA_SQL, SCHEMA_CONTRACT_CHECK_SQL } from "../postgres-schema";

describe("user-access schema SQL", () => {
  it("exports non-empty DDL string", () => {
    expect(typeof USER_ACCESS_SCHEMA_SQL).toBe("string");
    expect(USER_ACCESS_SCHEMA_SQL.length).toBeGreaterThan(100);
  });

  it("creates app_users table with IF NOT EXISTS", () => {
    expect(USER_ACCESS_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS app_users");
  });

  it("creates app_user_access_events table with IF NOT EXISTS", () => {
    expect(USER_ACCESS_SCHEMA_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS app_user_access_events"
    );
  });

  it("enforces lowercase email via CHECK constraint", () => {
    expect(USER_ACCESS_SCHEMA_SQL).toContain("email = lower(trim(email))");
  });

  it("constrains role to three valid values or null", () => {
    expect(USER_ACCESS_SCHEMA_SQL).toContain("'sales_rep', 'manager', 'admin'");
  });

  it("constrains status to three valid values", () => {
    expect(USER_ACCESS_SCHEMA_SQL).toContain("'pending', 'active', 'disabled'");
  });

  it("constrains version >= 1", () => {
    expect(USER_ACCESS_SCHEMA_SQL).toContain("version >= 1");
  });

  it("forbids contradictory role and status combinations", () => {
    expect(USER_ACCESS_SCHEMA_SQL).toContain("app_users_status_role_check");
    expect(USER_ACCESS_SCHEMA_SQL).toContain(
      "status = 'pending' AND role IS NULL"
    );
    expect(USER_ACCESS_SCHEMA_SQL).toContain(
      "status IN ('active', 'disabled') AND role IS NOT NULL"
    );
  });

  it("constrains event action to valid values", () => {
    expect(USER_ACCESS_SCHEMA_SQL).toContain("'access_requested'");
    expect(USER_ACCESS_SCHEMA_SQL).toContain("'approved'");
    expect(USER_ACCESS_SCHEMA_SQL).toContain("'role_changed'");
    expect(USER_ACCESS_SCHEMA_SQL).toContain("'disabled'");
    expect(USER_ACCESS_SCHEMA_SQL).toContain("'re_enabled'");
    expect(USER_ACCESS_SCHEMA_SQL).toContain("'pre_authorized'");
  });

  it("includes indexes for status and audit history", () => {
    expect(USER_ACCESS_SCHEMA_SQL).toContain("idx_app_users_status_updated");
    expect(USER_ACCESS_SCHEMA_SQL).toContain("idx_app_user_access_events_user_email");
  });

  it("events table references app_users via foreign key", () => {
    expect(USER_ACCESS_SCHEMA_SQL).toContain("REFERENCES app_users(email)");
  });

  it("exports a contract check query", () => {
    expect(typeof SCHEMA_CONTRACT_CHECK_SQL).toBe("string");
    expect(SCHEMA_CONTRACT_CHECK_SQL).toContain("app_users");
    expect(SCHEMA_CONTRACT_CHECK_SQL).toContain("app_user_access_events");
    expect(SCHEMA_CONTRACT_CHECK_SQL).toContain("state_constraint");
    expect(SCHEMA_CONTRACT_CHECK_SQL).toContain("append_trigger");
  });

  it("rejects updates, deletes, and truncation of access events", () => {
    expect(USER_ACCESS_SCHEMA_SQL).toContain(
      "reject_app_user_access_event_mutation"
    );
    expect(USER_ACCESS_SCHEMA_SQL).toContain(
      "BEFORE UPDATE OR DELETE ON app_user_access_events"
    );
    expect(USER_ACCESS_SCHEMA_SQL).toContain(
      "BEFORE TRUNCATE ON app_user_access_events"
    );
    expect(USER_ACCESS_SCHEMA_SQL).toContain(
      "app_user_access_events is append-only"
    );
  });
});

describe("schema drift guard (TS vs MJS)", () => {
  it("TS and MJS schema SQL exports are identical", async () => {
    // Dynamic import the .mjs file to compare
    const mjsModule = await import("../postgres-schema.mjs");
    expect(USER_ACCESS_SCHEMA_SQL).toBe(mjsModule.USER_ACCESS_SCHEMA_SQL);
    expect(SCHEMA_CONTRACT_CHECK_SQL).toBe(mjsModule.SCHEMA_CONTRACT_CHECK_SQL);
  });
});

describe("migration safety contract", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "scripts/migrate-user-access.mjs"),
    "utf8"
  );

  it("uses a transaction, lock, contract verification, and rollback", () => {
    expect(migration).toContain('client.query("BEGIN")');
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("SCHEMA_CONTRACT_CHECK_SQL");
    expect(migration).toContain("app_schema_versions");
    expect(migration).toContain('client.query("ROLLBACK")');
  });
});
