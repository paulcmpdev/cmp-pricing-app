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

export function normalizeDatabaseUrlForComparison(value) {
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Database URL must use postgres:// or postgresql://.");
  }
  const port = url.port || "5432";
  const database = url.pathname.replace(/^\/+/, "");
  return `postgresql://${url.hostname.toLowerCase()}:${port}/${database}`;
}
