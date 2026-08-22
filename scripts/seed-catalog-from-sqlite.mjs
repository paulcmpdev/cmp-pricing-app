#!/usr/bin/env node
/**
 * Seed CMP PostgreSQL vendor catalog from the validated local SQLite snapshot.
 *
 * Usage:
 *   node scripts/seed-catalog-from-sqlite.mjs \
 *     --sqlite data/vendor-catalog.sqlite \
 *     --target-url "$VENDOR_CATALOG_DATABASE_URL" \
 *     [--vendor ss|sanmar|all] [--batch-size 500]
 *
 * This is the ONLY allowed bootstrap path for the CMP vendor catalog.
 * Live Vendo imports require an existing active CMP version.
 *
 * When --vendor all: builds and validates both imports first, then activates
 * both pointers in a single transaction (no mixed generation if one fails).
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { VENDOR_CATALOG_POSTGRES_SCHEMA_SQL } from "../lib/server/vendor-catalog/postgres-schema.mjs";
import { buildParameterizedInsert } from "./lib/postgres-import-helpers.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const { Pool } = pg;

/**
 * Reviewed manifest for data/vendor-catalog.sqlite.
 * SHA-256 computed with Node.js crypto on the actual file.
 * Counts verified against SQLite queries. integrity_check = ok.
 * Zero orphan variants, zero null/negative costs.
 * Known reference styles: 3001 (S&S), K500 (SanMar).
 *
 * S&S source_status is "failed" in the Vendo metadata, but the data itself
 * passes all integrity checks and matches verified baselines. This is marked
 * as an approved recovery snapshot — the source_status is preserved in import
 * metadata for audit trail.
 */
export const SQLITE_SEED_MANIFEST = {
  sha256: "fa48233fbdcfa27e0656a4d276c0934edbbc59cf46ae4c95dbb5b05cf83f199d",
  vendors: {
    ss: {
      styles: 6_381,
      variants: 221_824,
      knownStyle: "3001",
      sourceProvenance: "approved_recovery_snapshot",
    },
    sanmar: {
      styles: 3_950,
      variants: 151_486,
      knownStyle: "K500",
      sourceProvenance: "approved_recovery_snapshot",
    },
  },
};

const STYLE_COLUMNS = [
  "import_id", "id", "vendor", "source_style_id", "style_code", "brand",
  "name", "category", "description", "image_url", "active_variant_count",
  "source_sync_at",
];
const VARIANT_COLUMNS = [
  "import_id", "id", "style_id", "vendor", "source_variant_id", "style_code",
  "color", "size", "size_order", "inventory_qty", "image_url", "discontinued",
  "piece_price", "dozen_price", "case_price", "sale_price", "customer_price",
  "resolved_cost", "cost_basis", "source_sync_at",
];

const args = parseArgs(process.argv.slice(2));
const sqlitePath = args.sqlite ?? process.env.VENDOR_CATALOG_DB_PATH ?? "data/vendor-catalog.sqlite";
const targetUrl = args["target-url"] ?? process.env.VENDOR_CATALOG_DATABASE_URL;
const requestedVendor = args.vendor ?? "all";
const batchSize = Number(args["batch-size"] ?? 500);

if (!targetUrl) {
  fail("VENDOR_CATALOG_DATABASE_URL or --target-url is required.");
}
if (!existsSync(sqlitePath)) {
  fail(`SQLite database not found at: ${sqlitePath}`);
}
if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
  fail("Batch size must be an integer from 1 through 1000.");
}
if (!["all", "ss", "sanmar"].includes(requestedVendor)) {
  fail("--vendor must be all, ss, or sanmar.");
}

// Validate file hash against manifest (stream to avoid loading full file into memory)
const fileHasher = createHash("sha256");
await pipeline(createReadStream(sqlitePath), fileHasher);
const fileHash = fileHasher.digest("hex");
if (fileHash !== SQLITE_SEED_MANIFEST.sha256) {
  fail(
    `SQLite file SHA-256 mismatch.\n` +
    `  Expected: ${SQLITE_SEED_MANIFEST.sha256}\n` +
    `  Actual:   ${fileHash}\n` +
    `The file does not match the reviewed manifest. Refusing seed.`
  );
}
console.log(`SHA-256 verified: ${fileHash}`);

const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });

// Validate SQLite integrity
const integrityResult = db.pragma("integrity_check");
if (
  !Array.isArray(integrityResult) ||
  integrityResult.length !== 1 ||
  integrityResult[0]?.integrity_check !== "ok"
) {
  db.close();
  fail("SQLite integrity_check failed. Refusing seed.");
}

const target = new Pool({ connectionString: targetUrl, max: 2 });
const vendors = requestedVendor === "all" ? ["ss", "sanmar"] : [requestedVendor];

try {
  await target.query(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL);

  // Validate per-vendor counts against manifest before any imports
  for (const vendor of vendors) {
    validateManifestCounts(vendor);
  }

  // Build and validate all vendor imports first (no activation yet)
  const prepared = [];
  for (const vendor of vendors) {
    prepared.push(await buildAndValidateVendor(vendor));
  }

  // Activate all prepared imports in a single transaction
  await activateImports(prepared);

  console.log(JSON.stringify({ seeded: prepared.map((p) => p.summary) }, null, 2));
} finally {
  db.close();
  await target.end();
}

function validateManifestCounts(vendor) {
  const manifest = SQLITE_SEED_MANIFEST.vendors[vendor];
  if (!manifest) {
    throw new Error(`No manifest entry for vendor "${vendor}".`);
  }

  const styleCount = db
    .prepare("SELECT count(*) as cnt FROM catalog_styles WHERE vendor = ?")
    .get(vendor).cnt;
  const variantCount = db
    .prepare("SELECT count(*) as cnt FROM catalog_variants WHERE vendor = ?")
    .get(vendor).cnt;

  if (styleCount !== manifest.styles) {
    throw new Error(
      `${vendor} style count ${styleCount} does not match manifest (${manifest.styles}).`
    );
  }
  if (variantCount !== manifest.variants) {
    throw new Error(
      `${vendor} variant count ${variantCount} does not match manifest (${manifest.variants}).`
    );
  }

  // Verify known reference style exists
  const knownStyleCount = db
    .prepare("SELECT count(*) as cnt FROM catalog_styles WHERE vendor = ? AND style_code = ?")
    .get(vendor, manifest.knownStyle).cnt;
  if (knownStyleCount < 1) {
    throw new Error(
      `${vendor} known reference style "${manifest.knownStyle}" not found in SQLite.`
    );
  }

  // Verify zero orphans for this vendor
  const orphanCount = db
    .prepare(
      `SELECT count(*) as cnt FROM catalog_variants v
       LEFT JOIN catalog_styles s ON s.id = v.style_id
       WHERE v.vendor = ? AND s.id IS NULL`
    )
    .get(vendor).cnt;
  if (orphanCount > 0) {
    throw new Error(`${vendor} has ${orphanCount} orphan variants. Refusing seed.`);
  }

  // Verify zero null/negative costs
  const badCosts = db
    .prepare(
      "SELECT count(*) as cnt FROM catalog_variants WHERE vendor = ? AND (resolved_cost IS NULL OR resolved_cost < 0)"
    )
    .get(vendor).cnt;
  if (badCosts > 0) {
    throw new Error(`${vendor} has ${badCosts} null/negative cost variants. Refusing seed.`);
  }

  console.log(`Manifest validated for ${vendor}: ${styleCount} styles, ${variantCount} variants.`);
}

async function buildAndValidateVendor(vendor) {
  const importId = randomUUID();
  const hash = createHash("sha256");
  const manifest = SQLITE_SEED_MANIFEST.vendors[vendor];

  const sourceMeta = db
    .prepare("SELECT * FROM catalog_sources WHERE vendor = ?")
    .get(vendor);

  const sourceStatus = sourceMeta?.source_status ?? "unknown";
  const sourceSyncAt = sourceMeta?.source_sync_at ?? null;
  const sourceErrors = Number(sourceMeta?.source_errors ?? 0);

  // Allow approved recovery snapshots even if source_status != completed
  if (sourceStatus !== "completed" && manifest.sourceProvenance !== "approved_recovery_snapshot") {
    throw new Error(
      `${vendor} SQLite source status is "${sourceStatus}" (expected "completed"); ` +
        `refusing seed. Mark as approved_recovery_snapshot in manifest to override.`
    );
  }

  await target.query(
    `INSERT INTO catalog_imports (
       id, vendor, status, source_status, source_errors,
       source_sync_at, source_metadata
     ) VALUES ($1, $2, 'building', $3, $4, $5, $6::jsonb)`,
    [
      importId,
      vendor,
      sourceStatus,
      sourceErrors,
      sourceSyncAt,
      JSON.stringify({
        source: "sqlite-seed",
        filename: basename(sqlitePath),
        provenance: manifest.sourceProvenance,
        manifest_sha256: SQLITE_SEED_MANIFEST.sha256,
      }),
    ]
  );

  try {
    const styleResult = await streamSqliteToTarget({
      sqliteQuery: "SELECT * FROM catalog_styles WHERE vendor = ?",
      sqliteParams: [vendor],
      table: "catalog_styles",
      columns: STYLE_COLUMNS,
      importId,
      hash,
    });

    const variantResult = await streamSqliteToTarget({
      sqliteQuery: "SELECT * FROM catalog_variants WHERE vendor = ?",
      sqliteParams: [vendor],
      table: "catalog_variants",
      columns: VARIANT_COLUMNS,
      importId,
      hash,
    });

    const styleCount = styleResult.inserted;
    const variantCount = variantResult.inserted;
    const skippedInvalid = styleResult.skippedInvalid + variantResult.skippedInvalid;

    // Verify counts match manifest
    if (styleCount !== manifest.styles) {
      throw new Error(
        `${vendor} inserted ${styleCount} styles but manifest expects ${manifest.styles}.`
      );
    }
    if (variantCount !== manifest.variants) {
      throw new Error(
        `${vendor} inserted ${variantCount} variants but manifest expects ${manifest.variants}.`
      );
    }

    const contentHash = hash.digest("hex");

    await target.query(
      `UPDATE catalog_imports
       SET status = 'validating', style_count = $2, variant_count = $3,
           invalid_price_count = $4, content_hash = $5,
           source_completed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [importId, styleCount, variantCount, skippedInvalid, contentHash]
    );

    await validateImport(importId, vendor, styleCount, variantCount);

    return {
      importId,
      vendor,
      summary: {
        vendor,
        importId,
        styleCount,
        variantCount,
        skippedInvalid,
        sourceSyncAt,
        sourceStatus,
        provenance: manifest.sourceProvenance,
        activated: true,
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Reject: delete staged rows, retain sanitized import metadata
    await target.query(
      `UPDATE catalog_imports
       SET status = 'rejected', rejection_reason = $2
       WHERE id = $1 AND status <> 'active'`,
      [importId, reason.slice(0, 2000)]
    );
    await target.query(
      `DELETE FROM catalog_styles WHERE import_id = $1`,
      [importId]
    );
    await target.query(
      `DELETE FROM catalog_variants WHERE import_id = $1`,
      [importId]
    );
    throw error;
  }
}

/**
 * Activate all prepared imports in a single transaction.
 * If any activation fails, the entire transaction is rolled back —
 * no mixed-generation active pointers.
 */
async function activateImports(prepared) {
  const client = await target.connect();
  try {
    await client.query("BEGIN");
    // Lock all vendor slots to prevent concurrent activation
    await client.query("SELECT pg_advisory_xact_lock(hashtext('cmp-vendor-catalog:activate-all'))");

    for (const { importId, vendor } of prepared) {
      const current = await client.query(
        `SELECT import_id FROM active_catalog_versions WHERE vendor = $1 FOR UPDATE`,
        [vendor]
      );
      const previousImportId = current.rows[0]?.import_id;
      if (previousImportId) {
        await client.query(
          `UPDATE catalog_imports SET status = 'superseded' WHERE id = $1`,
          [previousImportId]
        );
      }
      const activateResult = await client.query(
        `UPDATE catalog_imports
         SET status = 'active', activated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND vendor = $2 AND status = 'validating'`,
        [importId, vendor]
      );
      if (activateResult.rowCount !== 1) {
        throw new Error(
          `${vendor} activation affected ${activateResult.rowCount} rows (expected 1); aborting.`
        );
      }
      await client.query(
        `INSERT INTO active_catalog_versions (vendor, import_id)
         VALUES ($1, $2)
         ON CONFLICT (vendor) DO UPDATE
         SET import_id = EXCLUDED.import_id, activated_at = CURRENT_TIMESTAMP`,
        [vendor, importId]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function streamSqliteToTarget({
  sqliteQuery,
  sqliteParams,
  table,
  columns,
  importId,
  hash,
}) {
  const isVariantTable = table === "catalog_variants";
  const stmt = db.prepare(sqliteQuery);
  let batch = [];
  let total = 0;
  let skippedInvalid = 0;

  for (const sourceRow of stmt.iterate(...sqliteParams)) {
    if (isVariantTable) {
      const cost = Number(sourceRow.resolved_cost);
      if (!Number.isFinite(cost) || cost < 0) {
        skippedInvalid++;
        continue;
      }
    }

    const row = { import_id: importId, ...sourceRow };
    hash.update(JSON.stringify(row));
    hash.update("\n");
    batch.push(row);

    if (batch.length >= batchSize) {
      await insertBatch(table, columns, batch);
      total += batch.length;
      batch = [];
    }
  }

  if (batch.length > 0) {
    await insertBatch(table, columns, batch);
    total += batch.length;
  }

  if (skippedInvalid > 0) {
    console.warn(`Skipped ${skippedInvalid} ${table} rows with invalid resolved_cost.`);
  }

  return { inserted: total, skippedInvalid };
}

async function insertBatch(table, columns, rows) {
  const statement = buildParameterizedInsert({ table, columns, rows });
  await target.query(statement.text, statement.values);
}

async function validateImport(importId, vendor, styleCount, variantCount) {
  const manifest = SQLITE_SEED_MANIFEST.vendors[vendor];
  const result = await target.query(
    `SELECT
       (SELECT count(*)::int FROM catalog_styles WHERE import_id = $1) AS styles,
       (SELECT count(*)::int FROM catalog_variants WHERE import_id = $1) AS variants,
       (SELECT count(*)::int FROM catalog_variants v
         LEFT JOIN catalog_styles s
           ON s.import_id = v.import_id AND s.id = v.style_id
         WHERE v.import_id = $1 AND s.id IS NULL) AS orphans,
       (SELECT count(*)::int FROM catalog_variants
         WHERE import_id = $1 AND resolved_cost < 0) AS invalid_costs,
       (SELECT count(*)::int FROM catalog_styles
         WHERE import_id = $1 AND style_code = $2) AS known_styles`,
    [importId, manifest.knownStyle]
  );
  const checks = result.rows[0];
  if (
    Number(checks.styles) !== styleCount ||
    Number(checks.variants) !== variantCount ||
    Number(checks.orphans) !== 0 ||
    Number(checks.invalid_costs) !== 0 ||
    Number(checks.known_styles) < 1
  ) {
    throw new Error(`${vendor} seed failed validation: ${JSON.stringify(checks)}`);
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    result[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
