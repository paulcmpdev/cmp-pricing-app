#!/usr/bin/env node
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const args = parseArgs(process.argv.slice(2));
const output = resolve(args.output ?? "data/vendor-catalog.sqlite");
const importPath = `${output}.importing-${process.pid}`;
const postgresUrl = args["postgres-url"] ?? process.env.VENDO_POSTGRES_URL;
const dbContainer = args["db-container"] ?? process.env.VENDO_DB_CONTAINER ?? "vendo-db-inspect";
const batchSize = Number(args["batch-size"] ?? process.env.VENDOR_CATALOG_BATCH_SIZE ?? 1000);
const now = new Date().toISOString();

const schemaSql = `
CREATE TABLE catalog_sources (
  vendor TEXT PRIMARY KEY CHECK (vendor IN ('ss', 'sanmar')),
  source_sync_at TEXT,
  imported_at TEXT NOT NULL,
  source_status TEXT NOT NULL,
  source_errors INTEGER NOT NULL DEFAULT 0,
  variant_count INTEGER NOT NULL DEFAULT 0,
  style_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE catalog_styles (
  id TEXT PRIMARY KEY,
  vendor TEXT NOT NULL CHECK (vendor IN ('ss', 'sanmar')),
  source_style_id TEXT NOT NULL,
  style_code TEXT NOT NULL,
  brand TEXT,
  name TEXT,
  category TEXT,
  description TEXT,
  image_url TEXT,
  active_variant_count INTEGER NOT NULL DEFAULT 0,
  source_sync_at TEXT
);
CREATE TABLE catalog_variants (
  id TEXT PRIMARY KEY,
  style_id TEXT NOT NULL REFERENCES catalog_styles(id),
  vendor TEXT NOT NULL CHECK (vendor IN ('ss', 'sanmar')),
  source_variant_id TEXT NOT NULL,
  style_code TEXT NOT NULL,
  color TEXT,
  size TEXT,
  size_order INTEGER,
  inventory_qty INTEGER,
  image_url TEXT,
  discontinued INTEGER NOT NULL DEFAULT 0,
  piece_price REAL,
  dozen_price REAL,
  case_price REAL,
  sale_price REAL,
  customer_price REAL,
  resolved_cost REAL NOT NULL,
  cost_basis TEXT NOT NULL,
  source_sync_at TEXT
);
CREATE INDEX idx_catalog_styles_vendor ON catalog_styles(vendor);
CREATE INDEX idx_catalog_styles_style_code ON catalog_styles(style_code);
CREATE INDEX idx_catalog_styles_brand ON catalog_styles(brand);
CREATE INDEX idx_catalog_styles_name ON catalog_styles(name);
CREATE INDEX idx_catalog_variants_style_id ON catalog_variants(style_id);
CREATE INDEX idx_catalog_variants_vendor ON catalog_variants(vendor);
`;

const source = sql`
WITH attempts AS (
  SELECT
    CASE WHEN vendor_name ILIKE '%S&S%' THEN 'ss' ELSE 'sanmar' END vendor,
    completed_at,
    started_at,
    status,
    COALESCE(error_count, 0) error_count
  FROM sync_tasks
  WHERE vendor_name ILIKE '%S&S%' OR vendor_name ILIKE '%Sanmar%'
),
latest_attempt AS (
  SELECT vendor, completed_at, status, error_count
  FROM (
    SELECT *,
      row_number() OVER (
        PARTITION BY vendor
        ORDER BY completed_at DESC NULLS LAST, started_at DESC NULLS LAST
      ) rn
    FROM attempts
  ) ranked
  WHERE rn = 1
),
latest_success AS (
  SELECT vendor, completed_at
  FROM (
    SELECT *,
      row_number() OVER (
        PARTITION BY vendor
        ORDER BY completed_at DESC NULLS LAST, started_at DESC NULLS LAST
      ) rn
    FROM attempts
    WHERE status = 'completed' AND completed_at IS NOT NULL
  ) ranked
  WHERE rn = 1
)
SELECT
  latest_attempt.vendor,
  latest_success.completed_at source_sync_at,
  latest_attempt.status,
  latest_attempt.error_count
FROM latest_attempt
LEFT JOIN latest_success ON latest_success.vendor = latest_attempt.vendor;
`;

const ssStyles = sql`
WITH latest_success AS (
  SELECT completed_at
  FROM sync_tasks
  WHERE vendor_name ILIKE '%S&S%'
    AND status = 'completed'
    AND completed_at IS NOT NULL
  ORDER BY completed_at DESC
  LIMIT 1
)
SELECT
  'ss:' || s."styleID" id,
  'ss' vendor,
  s."styleID"::text source_style_id,
  COALESCE(s."styleName", s."uniqueStyleName", s."styleID"::text) style_code,
  s."brandName" brand,
  COALESCE(s."title", s."styleName", s."uniqueStyleName") name,
  s."baseCategory" category,
  s."description" description,
  s."styleImage" image_url,
  COUNT(CASE WHEN p."piecePrice" > 0 THEN 1 END)::int active_variant_count,
  latest_success.completed_at source_sync_at
FROM ss_styles s
JOIN ss_products p ON p."styleID" = s."styleID"
LEFT JOIN latest_success ON true
GROUP BY s."styleID", s."partNumber", s."brandName", s."title", s."styleName",
  s."uniqueStyleName", s."baseCategory", s."description", s."styleImage",
  latest_success.completed_at
HAVING COUNT(CASE WHEN p."piecePrice" > 0 THEN 1 END) > 0;
`;

const ssVariants = sql`
WITH latest_success AS (
  SELECT completed_at
  FROM sync_tasks
  WHERE vendor_name ILIKE '%S&S%'
    AND status = 'completed'
    AND completed_at IS NOT NULL
  ORDER BY completed_at DESC
  LIMIT 1
)
SELECT
  'ss:' || p."sku" id,
  'ss:' || p."styleID" style_id,
  'ss' vendor,
  p."sku" source_variant_id,
  COALESCE(s."styleName", s."uniqueStyleName", p."styleName", p."styleID"::text) style_code,
  p."colorName" color,
  p."sizeName" size,
  NULLIF(regexp_replace(COALESCE(p."sizeOrder", ''), '[^0-9]', '', 'g'), '')::int size_order,
  p."qty"::int inventory_qty,
  COALESCE(p."colorFrontImage", s."styleImage") image_url,
  false discontinued,
  p."piecePrice" piece_price,
  p."dozenPrice" dozen_price,
  p."casePrice" case_price,
  p."salePrice" sale_price,
  p."customerPrice" customer_price,
  p."piecePrice" resolved_cost,
  'piecePrice' cost_basis,
  latest_success.completed_at source_sync_at
FROM ss_products p
JOIN ss_styles s ON s."styleID" = p."styleID"
LEFT JOIN latest_success ON true
WHERE p."piecePrice" > 0;
`;

const sanmarStyles = sql`
WITH latest_success AS (
  SELECT completed_at
  FROM sync_tasks
  WHERE vendor_name ILIKE '%Sanmar%'
    AND status = 'completed'
    AND completed_at IS NOT NULL
  ORDER BY completed_at DESC
  LIMIT 1
)
SELECT
  'sanmar:' || s."style" id,
  'sanmar' vendor,
  s."style" source_style_id,
  s."style" style_code,
  max(s."brandName") brand,
  max(s."productTitle") name,
  max(s."category") category,
  max(s."productDescription") description,
  max(COALESCE(s."productImage", s."thumbnailImage")) image_url,
  COUNT(s."uniqueKey")::int active_variant_count,
  latest_success.completed_at source_sync_at
FROM sanmar_styles s
LEFT JOIN latest_success ON true
WHERE NULLIF(s."piecePrice", 0) IS NOT NULL
GROUP BY s."style", latest_success.completed_at;
`;

const sanmarVariants = sql`
WITH latest_success AS (
  SELECT completed_at
  FROM sync_tasks
  WHERE vendor_name ILIKE '%Sanmar%'
    AND status = 'completed'
    AND completed_at IS NOT NULL
  ORDER BY completed_at DESC
  LIMIT 1
)
SELECT
  'sanmar:' || s."uniqueKey" id,
  'sanmar:' || s."style" style_id,
  'sanmar' vendor,
  s."uniqueKey" source_variant_id,
  s."style" style_code,
  COALESCE(s."color", s."catalogColor") color,
  s."size" size,
  s."sizeIndex" size_order,
  NULL::int inventory_qty,
  COALESCE(s."colorProductImage", s."productImage", s."thumbnailImage", p."primaryImageUrl") image_url,
  COALESCE(s."discontinued", false) discontinued,
  s."piecePrice" piece_price,
  s."dozenPrice" dozen_price,
  s."casePrice" case_price,
  NULL::real sale_price,
  NULL::real customer_price,
  s."piecePrice" resolved_cost,
  'piecePrice' cost_basis,
  latest_success.completed_at source_sync_at
FROM sanmar_styles s
LEFT JOIN sanmar_products p ON p."partId" = s."inventoryKey"
LEFT JOIN latest_success ON true
WHERE NULLIF(s."piecePrice", 0) IS NOT NULL;
`;

const invalidSs = sql`
SELECT COUNT(*) count FROM ss_products
WHERE "piecePrice" IS NULL OR "piecePrice" <= 0;
`;

const invalidSanmar = sql`
SELECT COUNT(*) count FROM sanmar_styles WHERE NULLIF("piecePrice", 0) IS NULL;
`;

await main();

async function main() {
  mkdirSync(dirname(output), { recursive: true });
  for (const path of [importPath, `${importPath}-wal`, `${importPath}-shm`]) {
    if (existsSync(path)) rmSync(path);
  }

  const db = new Database(importPath);
  db.exec(schemaSql);
  db.pragma("journal_mode = WAL");

  const counts = {
    ss: { styles: 0, variants: 0 },
    sanmar: { styles: 0, variants: 0 },
  };

  const sourceRows = [];
  for await (const row of runPsqlRows(source)) sourceRows.push(row);

  counts.ss.styles = await insertRows(db, ssStyles, insertStyleStmt(db));
  counts.sanmar.styles = await insertRows(db, sanmarStyles, insertStyleStmt(db));
  counts.ss.variants = await insertRows(db, ssVariants, insertVariantStmt(db));
  counts.sanmar.variants = await insertRows(db, sanmarVariants, insertVariantStmt(db));
  insertSources(db, sourceRows, now, counts);

  const invalidPriceRows = {
    ss: Number((await firstRow(invalidSs))?.count ?? 0),
    sanmar: Number((await firstRow(invalidSanmar))?.count ?? 0),
  };

  db.pragma("wal_checkpoint(TRUNCATE)");
  db.pragma("journal_mode = DELETE");
  db.close();
  renameSync(importPath, output);

  console.log(JSON.stringify({
    output,
    importedAt: now,
    styles: { ss: counts.ss.styles, sanmar: counts.sanmar.styles },
    variants: { ss: counts.ss.variants, sanmar: counts.sanmar.variants },
    invalidPriceRows,
  }, null, 2));
}

function sql(strings, ...values) {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "no-container") {
      result.container = false;
    } else {
      result[key] = argv[i + 1];
      i += 1;
    }
  }
  return result;
}

async function insertRows(db, query, stmt) {
  let total = 0;
  let batch = [];
  const insertBatch = db.transaction((rows) => {
    for (const row of rows) stmt.run(projectRow(row, stmt.columns));
  });

  for await (const row of runPsqlRows(query)) {
    batch.push(row);
    if (batch.length >= batchSize) {
      insertBatch(batch);
      total += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    insertBatch(batch);
    total += batch.length;
  }
  return total;
}

async function firstRow(query) {
  for await (const row of runPsqlRows(query)) return row;
  return undefined;
}

function insertSources(db, rows, importedAt, counts) {
  const byVendor = new Map(rows.map((row) => [row.vendor, row]));
  const stmt = db.prepare(`
    INSERT INTO catalog_sources VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const vendor of ["ss", "sanmar"]) {
      const row = byVendor.get(vendor) ?? {};
      stmt.run(
        vendor,
        row.source_sync_at ?? null,
        importedAt,
        row.status ?? "unknown",
        Number(row.error_count ?? 0),
        counts[vendor].variants,
        counts[vendor].styles
      );
    }
  });
  tx();
}

function insertStyleStmt(db) {
  const stmt = db.prepare(`
    INSERT INTO catalog_styles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.columns = [
    "id", "vendor", "source_style_id", "style_code", "brand", "name",
    "category", "description", "image_url", "active_variant_count",
    "source_sync_at",
  ];
  return stmt;
}

function insertVariantStmt(db) {
  const stmt = db.prepare(`
    INSERT INTO catalog_variants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.columns = [
    "id", "style_id", "vendor", "source_variant_id", "style_code", "color",
    "size", "size_order", "inventory_qty", "image_url", "discontinued",
    "piece_price", "dozen_price", "case_price", "sale_price", "customer_price",
    "resolved_cost", "cost_basis", "source_sync_at",
  ];
  return stmt;
}

function projectRow(row, columns) {
  return columns.map((column) => {
    if (column === "discontinued") return row[column] ? 1 : 0;
    if (column === "active_variant_count") return Number(row[column] ?? 0);
    if (column === "size_order" || column === "inventory_qty") {
      return row[column] == null ? null : Number(row[column]);
    }
    return row[column] ?? null;
  });
}

async function* runPsqlRows(query) {
  const nestedQuery = query.trim().replace(/;$/, "");
  const rowSql = `SELECT row_to_json(t)::text FROM (${nestedQuery}) t`;
  const attempts = buildPsqlAttempts(rowSql);
  let lastError = "";

  for (const attempt of attempts) {
    const child = spawn(attempt.command, attempt.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line && line !== "\\N") yield JSON.parse(line);
      }
    } catch (error) {
      child.kill();
      throw error;
    }

    const code = await new Promise((resolveCode) => {
      child.on("close", resolveCode);
    });
    if (code === 0) return;
    lastError = stderr.trim() || `${attempt.command} exited with ${code}`;
  }

  throw new Error(lastError || "Unable to query Vendo PostgreSQL.");
}

function buildPsqlAttempts(copySql) {
  const psqlArgs = postgresUrl
    ? [postgresUrl, "-X", "-q", "-t", "-A", "-c", copySql]
    : ["-X", "-q", "-t", "-A", "-c", copySql];
  const attempts = [{ command: "psql", args: psqlArgs }];
  if (args.container !== false) {
    const containerPsql = [
      "exec", "-i", dbContainer, "psql", "-U", "vendo", "-d", "vendo",
      "-X", "-q", "-t", "-A", "-c", copySql,
    ];
    attempts.push({ command: "podman", args: containerPsql });
    attempts.push({ command: "docker", args: containerPsql });
  }
  return attempts.filter((attempt) => isCommandAvailable(attempt.command));
}

function isCommandAvailable(command) {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => existsSync(resolve(directory, command)));
}
