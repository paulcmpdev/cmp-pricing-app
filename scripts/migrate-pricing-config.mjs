#!/usr/bin/env node

/**
 * Migrate pricing-config schema to PostgreSQL.
 *
 * Usage:
 *   CMP_DATABASE_URL=postgres://... npm run pricing:migrate
 *
 * Falls back to VENDOR_CATALOG_DATABASE_URL if CMP_DATABASE_URL is not set.
 * Prints progress but never prints credentials.
 */

import pg from "pg";

const databaseUrl =
  process.env.CMP_DATABASE_URL ?? process.env.VENDOR_CATALOG_DATABASE_URL;

if (!databaseUrl) {
  console.error(
    "Error: Set CMP_DATABASE_URL or VENDOR_CATALOG_DATABASE_URL to run the migration."
  );
  process.exit(1);
}

const parsed = new URL(databaseUrl);
console.log(
  `Migrating pricing-config schema on ${parsed.hostname}${parsed.pathname} ...`
);

import {
  PRICING_CONFIG_CONTRACT_CHECK_SQL,
  PRICING_CONFIG_SCHEMA_SQL,
  PRICING_CONFIG_SCHEMA_VERSION,
} from "../lib/server/pricing-config/postgres-schema.mjs";

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 10_000,
});

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock($1)", [839274021]);
  await client.query(PRICING_CONFIG_SCHEMA_SQL);

  const contract = await client.query(PRICING_CONFIG_CONTRACT_CHECK_SQL);
  const checks = contract.rows[0] ?? {};
  const failures = Object.entries(checks).filter(([, v]) => v !== true);
  if (failures.length > 0) {
    console.error("Contract check failures:", failures.map(([k]) => k).join(", "));
    throw new Error("schema contract validation failed");
  }

  // Ensure app_schema_versions table exists (may already from user-access migration)
  const existing = await client.query(
    "SELECT version FROM app_schema_versions WHERE component = 'pricing_config' FOR UPDATE"
  );
  if (existing.rows.length === 0) {
    await client.query(
      "INSERT INTO app_schema_versions (component, version) VALUES ('pricing_config', $1)",
      [PRICING_CONFIG_SCHEMA_VERSION]
    );
  } else if (Number(existing.rows[0].version) !== PRICING_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported pricing-config schema version: expected ${PRICING_CONFIG_SCHEMA_VERSION}, found ${existing.rows[0].version}`
    );
  }

  await client.query("COMMIT");
  console.log("Pricing-config schema migration complete.");
} catch (err) {
  await client.query("ROLLBACK");
  console.error("Migration failed safely; no schema changes were committed.");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
