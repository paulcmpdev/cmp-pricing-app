import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertSSPiecePriceInvariant,
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
  INVALID_PRICE_QUERIES,
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

  it("assertSSPiecePriceInvariant accepts clean S&S staged rows", async () => {
    const target = {
      query: async (sql: string, params: unknown[]) => {
        expect(sql).toContain("vendor = 'ss'");
        expect(sql).toContain("piece_price IS NULL");
        expect(sql).toContain("piece_price <= 0");
        expect(sql).toContain("resolved_cost IS DISTINCT FROM piece_price");
        expect(sql).toContain("cost_basis IS DISTINCT FROM 'piecePrice'");
        expect(params).toEqual(["import-1"]);
        return { rows: [{ violations: 0 }] };
      },
    };

    await expect(assertSSPiecePriceInvariant(target, "import-1")).resolves.toBeUndefined();
  });

  it("assertSSPiecePriceInvariant rejects S&S staged rows that do not resolve to piecePrice", async () => {
    const target = {
      query: async () => ({ rows: [{ violations: 3 }] }),
    };

    await expect(assertSSPiecePriceInvariant(target, "import-2")).rejects.toThrow(
      /S&S import import-2 violates piece price activation invariant/i
    );
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

  it("Vendo PG importer stream filter rejects zero resolved_cost", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/import-vendo-catalog-postgres.mjs"),
      "utf8"
    );
    expect(source).toContain("cost <= 0");
  });

  it("Vendo PG importer validation checks zero-cost variants", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/import-vendo-catalog-postgres.mjs"),
      "utf8"
    );
    expect(source).toContain("resolved_cost <= 0");
  });

  it("Vendo PG importer asserts S&S piece-price invariant immediately before activation", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/import-vendo-catalog-postgres.mjs"),
      "utf8"
    );
    expect(source).toContain("assertSSPiecePriceInvariant");
    expect(source).toMatch(
      /await validateImport\(importId, vendor, styleCount, variantCount\);\s*await assertSSPiecePriceInvariant\(target, importId\);\s*await activateImport\(importId, vendor\);/
    );
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

describe("Seed script S&S invariant enforcement", () => {
  const seedSource = readFileSync(
    resolve(process.cwd(), "scripts/seed-catalog-from-sqlite.mjs"),
    "utf8"
  );

  it("source pre-validation counts and rejects S&S invariant failures before streaming", () => {
    expect(seedSource).toContain("bad_piece_price");
    expect(seedSource).toContain("wrong_basis");
    expect(seedSource).toContain("mismatched_cost");
    expect(seedSource).toContain("before streaming");
  });

  it("source pre-validation enforces S&S piece_price > 0 and cost_basis = piecePrice", () => {
    expect(seedSource).toContain("piece_price");
    expect(seedSource).toContain("cost_basis");
    expect(seedSource).toContain("piecePrice");
  });

  it("seed stream does not skip invalid S&S rows into a partial snapshot", () => {
    const streamBody = seedSource.slice(
      seedSource.indexOf("async function streamSqliteToTarget"),
      seedSource.indexOf("async function insertBatch")
    );
    expect(streamBody).not.toContain("continue;");
    expect(streamBody).not.toContain("Skipped ${skippedInvalid}");
  });

  it("PG validation query checks for zero-cost variants (not just negative)", () => {
    // validateImport must detect resolved_cost = 0 as invalid
    expect(seedSource).toContain("resolved_cost <= 0");
  });

  it("seed activation asserts S&S invariant in the activation transaction before pointer changes", () => {
    expect(seedSource).toMatch(
      /for \(const \{ importId, vendor \} of prepared\) \{\s*await assertSSPiecePriceInvariant\(client, importId\);\s*const current = await client.query/
    );
  });
});

describe("Legacy import (import-vendo-catalog.mjs) S&S price contract", () => {
  const legacySource = readFileSync(
    resolve(process.cwd(), "scripts/import-vendo-catalog.mjs"),
    "utf8"
  );

  it("SS variant WHERE requires piecePrice > 0 (not NULLIF)", () => {
    // The legacy import must use the same strictly-positive predicate
    expect(legacySource).toContain('WHERE p."piecePrice" > 0');
    expect(legacySource).not.toMatch(/WHERE\s+NULLIF\(p\."piecePrice"/);
  });

  it("SS invalid price count includes NULL, zero, and negative", () => {
    expect(legacySource).toContain('"piecePrice" IS NULL');
    expect(legacySource).toContain('"piecePrice" <= 0');
  });
});

describe("S&S source query price-filter contract", () => {
  it("SS_STYLES_QUERY active_variant_count requires piecePrice > 0", () => {
    expect(SS_STYLES_QUERY).toContain(
      `COUNT(CASE WHEN p."piecePrice" > 0 THEN 1 END)::int AS active_variant_count`
    );
  });

  it("SS_STYLES_QUERY excludes styles with zero piecePrice > 0 variants via HAVING", () => {
    expect(SS_STYLES_QUERY).toMatch(/HAVING\s+COUNT\s*\(\s*CASE\s+WHEN\s+p\."piecePrice"\s*>\s*0/i);
  });

  it("SS_VARIANTS_QUERY WHERE requires piecePrice > 0", () => {
    expect(SS_VARIANTS_QUERY).toContain(
      `WHERE p."piecePrice" > 0`
    );
  });

  it("SS_VARIANTS_QUERY does not use NULLIF for price filtering", () => {
    expect(SS_VARIANTS_QUERY).not.toContain('NULLIF(p."piecePrice"');
  });

  it("INVALID_PRICE_QUERIES.ss counts NULL, zero, and negative piecePrice", () => {
    expect(INVALID_PRICE_QUERIES.ss).toContain('"piecePrice" IS NULL');
    expect(INVALID_PRICE_QUERIES.ss).toContain('"piecePrice" <= 0');
  });

  it("SanMar styles and variants queries use the same price filter (unchanged)", () => {
    const SANMAR_PRICE_FILTER = 'NULLIF(s."piecePrice", 0)';
    expect(SANMAR_STYLES_QUERY).toContain(
      `WHERE ${SANMAR_PRICE_FILTER} IS NOT NULL`
    );
    expect(SANMAR_VARIANTS_QUERY).toContain(
      `WHERE ${SANMAR_PRICE_FILTER} IS NOT NULL`
    );
  });
});
