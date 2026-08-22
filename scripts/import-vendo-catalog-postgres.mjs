#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import QueryStream from "pg-query-stream";
import { VENDOR_CATALOG_POSTGRES_SCHEMA_SQL } from "../lib/server/vendor-catalog/postgres-schema.mjs";
import {
  INVALID_PRICE_QUERIES,
  SANMAR_STYLES_QUERY,
  SANMAR_VARIANTS_QUERY,
  SOURCE_METADATA_QUERY,
  SS_STYLES_QUERY,
  SS_VARIANTS_QUERY,
} from "./lib/vendor-catalog-source-queries.mjs";
import {
  assertSafeCatalogCounts,
  buildParameterizedInsert,
  normalizeDatabaseUrlForComparison,
} from "./lib/postgres-import-helpers.mjs";

const { Pool } = pg;
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
const sourceUrl = args["source-url"] ?? process.env.VENDO_POSTGRES_URL;
const targetUrl = args["target-url"] ?? process.env.VENDOR_CATALOG_DATABASE_URL;
const requestedVendor = args.vendor;
const batchSize = Number(args["batch-size"] ?? process.env.VENDOR_CATALOG_BATCH_SIZE ?? 500);

if (!sourceUrl || !targetUrl) {
  fail("VENDO_POSTGRES_URL and VENDOR_CATALOG_DATABASE_URL are required.");
}
if (normalizeDatabaseUrlForComparison(sourceUrl) === normalizeDatabaseUrlForComparison(targetUrl)) {
  fail("Source and target databases must be different.");
}
if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
  fail("Batch size must be an integer from 1 through 1000.");
}
if (!["ss", "sanmar"].includes(requestedVendor)) {
  fail("--vendor must be ss or sanmar (explicit per-vendor imports required).");
}

const source = new Pool({ connectionString: sourceUrl, max: 2 });
const target = new Pool({ connectionString: targetUrl, max: 4 });

try {
  await target.query(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL);
  const metadataResult = await source.query(SOURCE_METADATA_QUERY);
  const metadata = new Map(metadataResult.rows.map((row) => [row.vendor, row]));
  const result = await importVendor(requestedVendor, metadata.get(requestedVendor) ?? {});
  console.log(JSON.stringify({ imported: [result] }, null, 2));
} finally {
  await Promise.allSettled([source.end(), target.end()]);
}

async function importVendor(vendor, sourceMetadata) {
  const importId = randomUUID();
  const sourceSyncAt = sourceMetadata.source_sync_at ?? null;
  const sourceStartedAt = sourceMetadata.source_started_at ?? null;
  const sourceStatus = sourceMetadata.source_status ?? "unknown";
  const sourceErrors = Number(sourceMetadata.source_errors ?? 0);

  if (sourceStatus !== "completed") {
    throw new Error(
      `${vendor} source status is "${sourceStatus}" (expected "completed"); ` +
        `refusing import to avoid ingesting partial data.`
    );
  }

  const hash = createHash("sha256");

  await target.query(
    `INSERT INTO catalog_imports (
       id, vendor, status, source_started_at, source_status, source_errors,
       source_sync_at, source_metadata
     ) VALUES ($1, $2, 'building', $3, $4, $5, $6, $7::jsonb)`,
    [
      importId,
      vendor,
      sourceStartedAt,
      sourceStatus,
      sourceErrors,
      sourceSyncAt,
      JSON.stringify({ source: "vendo-postgresql" }),
    ]
  );

  try {
    const styleQuery = vendor === "ss" ? SS_STYLES_QUERY : SANMAR_STYLES_QUERY;
    const variantQuery = vendor === "ss" ? SS_VARIANTS_QUERY : SANMAR_VARIANTS_QUERY;
    const styleResult = await streamIntoTarget({
      query: styleQuery,
      table: "catalog_styles",
      columns: STYLE_COLUMNS,
      importId,
      hash,
    });
    const variantResult = await streamIntoTarget({
      query: variantQuery,
      table: "catalog_variants",
      columns: VARIANT_COLUMNS,
      importId,
      hash,
    });
    const styleCount = styleResult.inserted;
    const variantCount = variantResult.inserted;
    const skippedInvalid = styleResult.skippedInvalid + variantResult.skippedInvalid;
    const invalidResult = await source.query(INVALID_PRICE_QUERIES[vendor]);
    const invalidPriceCount = Number(invalidResult.rows[0]?.count ?? 0) + skippedInvalid;
    const previous = await getActiveCounts(vendor);

    assertSafeCatalogCounts({
      vendor,
      styleCount,
      variantCount,
      previousStyleCount: previous?.style_count ?? null,
      previousVariantCount: previous?.variant_count ?? null,
    });

    await target.query(
      `UPDATE catalog_imports
       SET status = 'validating', style_count = $2, variant_count = $3,
           invalid_price_count = $4, content_hash = $5,
           source_completed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [importId, styleCount, variantCount, invalidPriceCount, hash.digest("hex")]
    );
    await validateImport(importId, vendor, styleCount, variantCount);
    await activateImport(importId, vendor);

    return {
      vendor,
      importId,
      styleCount,
      variantCount,
      invalidPriceCount,
      skippedInvalid,
      sourceSyncAt,
      sourceStatus,
      sourceErrors,
      activated: true,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Reject: delete staged style/variant rows via CASCADE, retain import metadata
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

async function streamIntoTarget({ query, table, columns, importId, hash }) {
  const isVariantTable = table === "catalog_variants";
  const client = await source.connect();
  const stream = client.query(new QueryStream(query, [], { batchSize }));
  let rows = [];
  let total = 0;
  let skippedInvalid = 0;
  try {
    for await (const sourceRow of stream) {
      // Validate numeric cost fields on variant rows
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
      rows.push(row);
      if (rows.length >= batchSize) {
        await insertBatch(table, columns, rows);
        total += rows.length;
        rows = [];
      }
    }
    if (rows.length > 0) {
      await insertBatch(table, columns, rows);
      total += rows.length;
    }
    if (skippedInvalid > 0) {
      console.warn(`Skipped ${skippedInvalid} ${table} rows with invalid resolved_cost.`);
    }
    return { inserted: total, skippedInvalid };
  } finally {
    stream.destroy();
    client.release();
  }
}

async function insertBatch(table, columns, rows) {
  const statement = buildParameterizedInsert({ table, columns, rows });
  await target.query(statement.text, statement.values);
}

async function getActiveCounts(vendor) {
  const result = await target.query(
    `SELECT i.style_count, i.variant_count
     FROM active_catalog_versions a
     JOIN catalog_imports i ON i.id = a.import_id
     WHERE a.vendor = $1`,
    [vendor]
  );
  return result.rows[0];
}

async function validateImport(importId, vendor, styleCount, variantCount) {
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
    [importId, vendor === "ss" ? "3001" : "K500"]
  );
  const checks = result.rows[0];
  if (
    Number(checks.styles) !== styleCount ||
    Number(checks.variants) !== variantCount ||
    Number(checks.orphans) !== 0 ||
    Number(checks.invalid_costs) !== 0 ||
    Number(checks.known_styles) < 1
  ) {
    throw new Error(`${vendor} import failed validation: ${JSON.stringify(checks)}`);
  }
}

async function activateImport(importId, vendor) {
  const client = await target.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `cmp-vendor-catalog:${vendor}`,
    ]);
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
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
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
