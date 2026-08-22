import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertSafeCatalogCounts,
  buildParameterizedInsert,
  normalizeDatabaseUrlForComparison,
  PG_MAX_PARAMETERS,
} from "../lib/postgres-import-helpers.mjs";
import {
  SS_STYLES_QUERY,
  SS_VARIANTS_QUERY,
  SANMAR_STYLES_QUERY,
  SANMAR_VARIANTS_QUERY,
} from "../lib/vendor-catalog-source-queries.mjs";

describe("PostgreSQL catalog import safety", () => {
  it("declares import columns before top-level execution", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/import-vendo-catalog-postgres.mjs"),
      "utf8"
    );
    expect(source.indexOf("const STYLE_COLUMNS")).toBeGreaterThan(-1);
    expect(source.indexOf("const STYLE_COLUMNS")).toBeLessThan(
      source.indexOf("await target.query(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL)")
    );
  });

  it("builds parameterized multi-row inserts", () => {
    const result = buildParameterizedInsert({
      table: "catalog_styles",
      columns: ["import_id", "id", "vendor"],
      rows: [
        { import_id: "a", id: "ss:29", vendor: "ss" },
        { import_id: "a", id: "ss:39", vendor: "ss" },
      ],
    });

    expect(result.text).toContain(
      'INSERT INTO "catalog_styles" ("import_id", "id", "vendor")'
    );
    expect(result.text).toContain("($1, $2, $3), ($4, $5, $6)");
    expect(result.values).toEqual(["a", "ss:29", "ss", "a", "ss:39", "ss"]);
  });

  it("rejects unsafe identifiers", () => {
    expect(() =>
      buildParameterizedInsert({
        table: "catalog_styles; DROP TABLE catalog_imports",
        columns: ["id"],
        rows: [{ id: "x" }],
      })
    ).toThrow(/unsafe SQL identifier/i);
  });

  it("rejects first import without active CMP version (no bootstrap)", () => {
    // Live imports always require an existing active version
    expect(() =>
      assertSafeCatalogCounts({
        vendor: "ss",
        styleCount: 6_381,
        variantCount: 221_824,
        previousStyleCount: null,
        previousVariantCount: null,
      })
    ).toThrow(/no active CMP version/i);
  });

  it("rejects empty import even with active version", () => {
    expect(() =>
      assertSafeCatalogCounts({
        vendor: "ss",
        styleCount: 0,
        variantCount: 0,
        previousStyleCount: 6_381,
        previousVariantCount: 221_824,
      })
    ).toThrow(/empty/i);
  });

  it("rejects unexplained large count drops", () => {
    expect(() =>
      assertSafeCatalogCounts({
        vendor: "ss",
        styleCount: 5000,
        variantCount: 150000,
        previousStyleCount: 6381,
        previousVariantCount: 221824,
      })
    ).toThrow(/more than 20%/i);
  });

  it("rejects S&S 5,112/185,839 first import when no active previous version exists", () => {
    // These counts are plausible but irrelevant — ANY first import is rejected
    // because live imports require an existing active CMP version.
    expect(() =>
      assertSafeCatalogCounts({
        vendor: "ss",
        styleCount: 5_112,
        variantCount: 185_839,
        previousStyleCount: null,
        previousVariantCount: null,
      })
    ).toThrow(/no active CMP version/i);
  });

  it("accepts import with existing active version and normal counts", () => {
    expect(() =>
      assertSafeCatalogCounts({
        vendor: "ss",
        styleCount: 6_381,
        variantCount: 221_824,
        previousStyleCount: 6_381,
        previousVariantCount: 221_824,
      })
    ).not.toThrow();

    expect(() =>
      assertSafeCatalogCounts({
        vendor: "sanmar",
        styleCount: 3_950,
        variantCount: 151_486,
        previousStyleCount: 3_900,
        previousVariantCount: 150_000,
      })
    ).not.toThrow();
  });

  it("rejects batches that would exceed PG parameter limit", () => {
    const manyRows = Array.from({ length: 4000 }, (_, i) => ({
      c1: i, c2: i, c3: i, c4: i, c5: i, c6: i, c7: i, c8: i, c9: i,
      c10: i, c11: i, c12: i, c13: i, c14: i, c15: i, c16: i, c17: i,
    }));
    expect(() =>
      buildParameterizedInsert({
        table: "catalog_variants",
        columns: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9",
                   "c10", "c11", "c12", "c13", "c14", "c15", "c16", "c17"],
        rows: manyRows,
      })
    ).toThrow(/exceeds PostgreSQL limit/i);
  });

  it("exports PG_MAX_PARAMETERS constant", () => {
    expect(PG_MAX_PARAMETERS).toBe(65_535);
  });

  it("rejects variants fewer than styles", () => {
    expect(() =>
      assertSafeCatalogCounts({
        vendor: "ss",
        styleCount: 6_000,
        variantCount: 5_000,
        previousStyleCount: 6_000,
        previousVariantCount: 200_000,
      })
    ).toThrow(/fewer variants than styles/i);
  });

  it("rejects non-integer counts", () => {
    expect(() =>
      assertSafeCatalogCounts({
        vendor: "ss",
        styleCount: 6000.5,
        variantCount: 200_000,
        previousStyleCount: null,
        previousVariantCount: null,
      })
    ).toThrow(/integers/i);
  });

  it("normalizes database URLs before source-target comparison", () => {
    expect(
      normalizeDatabaseUrlForComparison("postgres://user:secret@LOCALHOST:5432/catalog")
    ).toBe("postgresql://localhost:5432/catalog");
  });

  it("Vendo importer refuses import when source_status is not completed", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/import-vendo-catalog-postgres.mjs"),
      "utf8"
    );
    expect(source).toContain('sourceStatus !== "completed"');
    expect(source).toContain("refusing import to avoid ingesting partial data");
  });

  it("Vendo importer requires explicit per-vendor (no --vendor all)", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/import-vendo-catalog-postgres.mjs"),
      "utf8"
    );
    expect(source).toContain('"ss", "sanmar"');
    expect(source).not.toMatch(/requestedVendor === "all"/);
  });

  it("Vendo importer checks activation affected rows", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/import-vendo-catalog-postgres.mjs"),
      "utf8"
    );
    expect(source).toContain("activateResult.rowCount !== 1");
  });

  it("Vendo importer cleans up staged rows on rejection", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/import-vendo-catalog-postgres.mjs"),
      "utf8"
    );
    expect(source).toContain("DELETE FROM catalog_styles WHERE import_id");
    expect(source).toContain("DELETE FROM catalog_variants WHERE import_id");
  });

  it("seed script allows approved recovery snapshot with source_status != completed", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/seed-catalog-from-sqlite.mjs"),
      "utf8"
    );
    expect(source).toContain("SQLITE_SEED_MANIFEST");
    expect(source).toContain("approved_recovery_snapshot");
  });

  it("seed script does not store absolute path in source_metadata", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/seed-catalog-from-sqlite.mjs"),
      "utf8"
    );
    // Must use basename-only filename, not the raw sqlitePath
    expect(source).toContain("filename: basename(sqlitePath)");
    expect(source).not.toMatch(/path:\s*sqlitePath/);
  });

  it("seed script hashes SQLite file with streaming, not readFileSync", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/seed-catalog-from-sqlite.mjs"),
      "utf8"
    );
    expect(source).toContain("createReadStream(sqlitePath)");
    expect(source).not.toContain("readFileSync(sqlitePath)");
  });

  it("package.json pins engines.node to 20.x (better-sqlite3 ABI compatibility)", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8")
    );
    expect(pkg.engines.node).toBe("20.x");
  });
});

describe("S&S source query price-filter contract", () => {
  const SS_PRICE_FILTER =
    'COALESCE(NULLIF(p."customerPrice", 0), NULLIF(p."salePrice", 0), NULLIF(p."piecePrice", 0))';

  it("SS_STYLES_QUERY active_variant_count uses the same price filter as SS_VARIANTS_QUERY WHERE", () => {
    // The styles query must count only priced-eligible rows, matching the
    // variants query's WHERE clause, so active_variant_count equals actual
    // imported variant count per style.
    expect(SS_STYLES_QUERY).toContain(
      `COUNT(CASE WHEN ${SS_PRICE_FILTER} IS NOT NULL THEN 1 END)::int AS active_variant_count`
    );
    expect(SS_VARIANTS_QUERY).toContain(
      `WHERE ${SS_PRICE_FILTER} IS NOT NULL`
    );
  });

  it("SanMar styles and variants queries use the same price filter", () => {
    const SANMAR_PRICE_FILTER = 'NULLIF(s."piecePrice", 0)';
    expect(SANMAR_STYLES_QUERY).toContain(
      `WHERE ${SANMAR_PRICE_FILTER} IS NOT NULL`
    );
    expect(SANMAR_VARIANTS_QUERY).toContain(
      `WHERE ${SANMAR_PRICE_FILTER} IS NOT NULL`
    );
  });
});
