#!/usr/bin/env node

/**
 * Migrate user-access schema to PostgreSQL.
 *
 * Usage:
 *   CMP_DATABASE_URL=postgres://... npm run access:migrate
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

// Print only the host/database, never full credentials
const parsed = new URL(databaseUrl);
console.log(
  `Migrating user-access schema on ${parsed.hostname}${parsed.pathname} ...`
);

import {
  SCHEMA_CONTRACT_CHECK_SQL,
  USER_ACCESS_SCHEMA_SQL,
  USER_ACCESS_SCHEMA_VERSION,
} from "../lib/server/user-access/postgres-schema.mjs";

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 10_000,
});

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock($1)", [839274018]);
  await client.query(USER_ACCESS_SCHEMA_SQL);

  const contract = await client.query(SCHEMA_CONTRACT_CHECK_SQL);
  const checks = contract.rows[0] ?? {};
  if (Object.values(checks).some((value) => value !== true)) {
    throw new Error("schema contract validation failed");
  }

  const existing = await client.query(
    "SELECT version FROM app_schema_versions WHERE component = 'user_access' FOR UPDATE"
  );
  if (existing.rows.length === 0) {
    await client.query(
      "INSERT INTO app_schema_versions (component, version) VALUES ('user_access', $1)",
      [USER_ACCESS_SCHEMA_VERSION]
    );
  } else if (Number(existing.rows[0].version) !== USER_ACCESS_SCHEMA_VERSION) {
    throw new Error("unsupported user-access schema version");
  }

  await client.query("COMMIT");
  console.log("User-access schema migration complete.");
} catch {
  await client.query("ROLLBACK");
  console.error("Migration failed safely; no schema changes were committed.");
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
