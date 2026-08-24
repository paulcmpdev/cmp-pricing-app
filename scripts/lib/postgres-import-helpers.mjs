const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

// PostgreSQL maximum parameter count per query
export const PG_MAX_PARAMETERS = 65_535;

function quoteIdentifier(identifier) {
  if (!SAFE_IDENTIFIER.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export function buildParameterizedInsert({ table, columns, rows }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("At least one row is required for a bulk insert.");
  }
  const parameterCount = rows.length * columns.length;
  if (parameterCount > PG_MAX_PARAMETERS) {
    throw new Error(
      `Batch of ${rows.length} rows x ${columns.length} columns = ${parameterCount} parameters ` +
        `exceeds PostgreSQL limit of ${PG_MAX_PARAMETERS}. Reduce batch size.`
    );
  }
  const tableSql = quoteIdentifier(table);
  const columnSql = columns.map(quoteIdentifier).join(", ");
  const values = [];
  const rowSql = rows.map((row) => {
    const placeholders = columns.map((column) => {
      values.push(Object.prototype.hasOwnProperty.call(row, column) ? row[column] : null);
      return `$${values.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });

  return {
    text: `INSERT INTO ${tableSql} (${columnSql}) VALUES ${rowSql.join(", ")}`,
    values,
  };
}

/**
 * Validate catalog counts for a live Vendo import.
 * Live imports ALWAYS require an existing active CMP version — the seed
 * script is the only allowed bootstrap path. This prevents a partial or
 * corrupt Vendo snapshot from becoming the first active version.
 */
export function assertSafeCatalogCounts({
  vendor,
  styleCount,
  variantCount,
  previousStyleCount,
  previousVariantCount,
  maximumDropFraction = 0.2,
}) {
  if (!Number.isSafeInteger(styleCount) || !Number.isSafeInteger(variantCount)) {
    throw new Error(`${vendor} catalog counts must be integers.`);
  }
  if (styleCount <= 0 || variantCount <= 0) {
    throw new Error(`${vendor} import is empty; refusing activation.`);
  }
  if (variantCount < styleCount) {
    throw new Error(`${vendor} import has fewer variants than styles.`);
  }

  const hasPrevious =
    previousStyleCount != null &&
    previousStyleCount > 0 &&
    previousVariantCount != null &&
    previousVariantCount > 0;

  if (!hasPrevious) {
    throw new Error(
      `${vendor} has no active CMP version; live imports require an existing ` +
        `active version. Use the seed script to bootstrap the initial catalog.`
    );
  }

  for (const [label, current, previous] of [
    ["style", styleCount, previousStyleCount],
    ["variant", variantCount, previousVariantCount],
  ]) {
    if (previous == null || previous <= 0) continue;
    const minimum = previous * (1 - maximumDropFraction);
    if (current < minimum) {
      throw new Error(
        `${vendor} ${label} count dropped more than ${maximumDropFraction * 100}% ` +
          `(${previous} -> ${current}); refusing activation.`
      );
    }
  }
}

export async function assertSSPiecePriceInvariant(target, importId) {
  const result = await target.query(
    `WITH import_row AS (
       SELECT id, vendor, variant_count
       FROM catalog_imports
       WHERE id = $1
     ),
     variant_stats AS (
       SELECT
         count(*)::int AS actual_variant_count,
         count(*) FILTER (WHERE vendor IS DISTINCT FROM 'ss')::int AS non_ss_variant_count,
         count(*) FILTER (
           WHERE vendor = 'ss'
             AND (
               piece_price IS NULL
               OR piece_price <= 0
               OR resolved_cost IS DISTINCT FROM piece_price
               OR cost_basis IS DISTINCT FROM 'piecePrice'
             )
         )::int AS piece_price_violation_count
       FROM catalog_variants
       WHERE import_id = $1
     )
     SELECT
       (i.id IS NOT NULL) AS import_exists,
       i.vendor AS import_vendor,
       i.variant_count::int AS expected_variant_count,
       v.actual_variant_count,
       v.non_ss_variant_count,
       v.piece_price_violation_count
     FROM variant_stats v
     LEFT JOIN import_row i ON true`,
    [importId]
  );
  const row = result.rows[0] ?? {};
  const importExists = row.import_exists === true;
  const importVendor = row.import_vendor ?? null;
  const expectedVariantCount = row.expected_variant_count == null
    ? null
    : Number(row.expected_variant_count);
  const actualVariantCount = Number(row.actual_variant_count ?? 0);
  const nonSSVariantCount = Number(row.non_ss_variant_count ?? 0);
  const piecePriceViolationCount = Number(row.piece_price_violation_count ?? 0);

  if (!importExists) {
    throw new Error(
      `S&S import ${importId} violates piece price activation invariant: import does not exist; refusing activation.`
    );
  }
  if (importVendor !== "ss") {
    throw new Error(
      `S&S import ${importId} violates piece price activation invariant: catalog_imports.vendor is ${JSON.stringify(importVendor)}; refusing activation.`
    );
  }
  if (!Number.isSafeInteger(expectedVariantCount) || expectedVariantCount <= 0) {
    throw new Error(
      `S&S import ${importId} violates piece price activation invariant: catalog_imports.variant_count must be positive; refusing activation.`
    );
  }
  if (actualVariantCount !== expectedVariantCount) {
    throw new Error(
      `S&S import ${importId} violates piece price activation invariant: staged variant count ${actualVariantCount} does not match expected ${expectedVariantCount}; refusing activation.`
    );
  }
  if (nonSSVariantCount > 0) {
    throw new Error(
      `S&S import ${importId} has ${nonSSVariantCount} non-S&S staged variant(s) violating piece price activation invariant; refusing activation.`
    );
  }
  if (piecePriceViolationCount > 0) {
    throw new Error(
      `S&S import ${importId} violates piece price activation invariant: ` +
        `${piecePriceViolationCount} variant(s) require piece_price > 0, ` +
        `resolved_cost = piece_price, and cost_basis = piecePrice.`
    );
  }
}

/**
 * Assert the SanMar case-price invariant on staged variants.
 * Every SanMar variant must have: case_price IS NOT NULL, case_price > 0,
 * resolved_cost = case_price, and cost_basis = 'casePrice'.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} target
 * @param {string} importId
 * @returns {Promise<void>}
 */
export async function assertSanMarCasePriceInvariant(target, importId) {
  const result = await target.query(
    `WITH import_row AS (
       SELECT id, vendor, variant_count
       FROM catalog_imports
       WHERE id = $1
     ),
     variant_stats AS (
       SELECT
         count(*)::int AS actual_variant_count,
         count(*) FILTER (WHERE vendor IS DISTINCT FROM 'sanmar')::int AS non_sanmar_variant_count,
         count(*) FILTER (
           WHERE vendor = 'sanmar'
             AND (
               case_price IS NULL
               OR case_price <= 0
               OR resolved_cost IS DISTINCT FROM case_price
               OR cost_basis IS DISTINCT FROM 'casePrice'
             )
         )::int AS case_price_violation_count
       FROM catalog_variants
       WHERE import_id = $1
     )
     SELECT
       (i.id IS NOT NULL) AS import_exists,
       i.vendor AS import_vendor,
       i.variant_count::int AS expected_variant_count,
       v.actual_variant_count,
       v.non_sanmar_variant_count,
       v.case_price_violation_count
     FROM variant_stats v
     LEFT JOIN import_row i ON true`,
    [importId]
  );
  const row = result.rows[0] ?? {};
  const importExists = row.import_exists === true;
  const importVendor = row.import_vendor ?? null;
  const expectedVariantCount = row.expected_variant_count == null
    ? null
    : Number(row.expected_variant_count);
  const actualVariantCount = Number(row.actual_variant_count ?? 0);
  const nonSanmarVariantCount = Number(row.non_sanmar_variant_count ?? 0);
  const casePriceViolationCount = Number(row.case_price_violation_count ?? 0);

  if (!importExists) {
    throw new Error(
      `sanmar import ${importId} violates case-price invariant: import does not exist; refusing activation.`
    );
  }
  if (importVendor !== "sanmar") {
    throw new Error(
      `sanmar import ${importId} violates case-price invariant: catalog_imports.vendor is ${JSON.stringify(importVendor)}; refusing activation.`
    );
  }
  if (!Number.isSafeInteger(expectedVariantCount) || expectedVariantCount <= 0) {
    throw new Error(
      `sanmar import ${importId} violates case-price invariant: catalog_imports.variant_count must be positive; refusing activation.`
    );
  }
  if (actualVariantCount !== expectedVariantCount) {
    throw new Error(
      `sanmar import ${importId} violates case-price invariant: staged variant count ${actualVariantCount} does not match expected ${expectedVariantCount}; refusing activation.`
    );
  }
  if (nonSanmarVariantCount > 0) {
    throw new Error(
      `sanmar import ${importId} has ${nonSanmarVariantCount} non-SanMar staged variant(s) violating case-price invariant; refusing activation.`
    );
  }
  if (casePriceViolationCount > 0) {
    throw new Error(
      `sanmar import ${importId} has ${casePriceViolationCount} variant(s) violating case-price invariant ` +
      `(require case_price > 0, resolved_cost = case_price, cost_basis = 'casePrice'); refusing activation.`
    );
  }
}

export function normalizeDatabaseUrlForComparison(value) {
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Database URL must use postgres:// or postgresql://.");
  }
  const port = url.port || "5432";
  const database = url.pathname.replace(/^\/+/, "");
  return `postgresql://${url.hostname.toLowerCase()}:${port}/${database}`;
}
