import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVendorCatalogTestDb } from "@/tests/fixtures/vendor-catalog/build-test-db";
import {
  getVendorCatalogStatus,
  resolveCatalogVariantCost,
  searchVendorCatalogStyles,
  getVendorCatalogStyleVariants,
} from "../repository";

const originalPath = process.env.VENDOR_CATALOG_DB_PATH;
const tempDirs: string[] = [];

function useFixtureDb() {
  const dir = mkdtempSync(join(tmpdir(), "cmp-vendor-catalog-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "vendor-catalog.sqlite");
  buildVendorCatalogTestDb(dbPath);
  process.env.VENDOR_CATALOG_DB_PATH = dbPath;
  return dbPath;
}

afterEach(() => {
  if (originalPath == null) {
    delete process.env.VENDOR_CATALOG_DB_PATH;
  } else {
    process.env.VENDOR_CATALOG_DB_PATH = originalPath;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("vendor catalog repository", () => {
  it("reports graceful unavailable state when no SQLite path is configured", () => {
    delete process.env.VENDOR_CATALOG_DB_PATH;

    expect(getVendorCatalogStatus()).toEqual({
      available: false,
      reason: "VENDOR_CATALOG_DB_PATH is not configured.",
    });
  });

  it("ranks exact style matches before prefix and substring matches", () => {
    useFixtureDb();

    const results = searchVendorCatalogStyles({ query: "3001", vendor: "all" });

    expect(results.map((style) => style.styleCode)).toEqual([
      "3001",
      "3001C",
      "B3001",
    ]);
  });

  it("returns public style and variant fields without monetary data", () => {
    useFixtureDb();

    const [style] = searchVendorCatalogStyles({ query: "K500", vendor: "sanmar" });
    const variants = getVendorCatalogStyleVariants(style.id);

    expect(style).toMatchObject({
      id: "sanmar:K500",
      vendor: "sanmar",
      styleCode: "K500",
      brand: "Port Authority",
    });
    expect(Object.keys(style).join(" ")).not.toMatch(/cost|price|cogs/i);
    expect(variants).toHaveLength(2);
    for (const variant of variants) {
      expect(Object.keys(variant).join(" ")).not.toMatch(/cost|price|cogs/i);
    }
  });

  it("returns undefined for an unknown variant ID", () => {
    useFixtureDb();

    expect(resolveCatalogVariantCost("ss:does-not-exist")).toBeUndefined();
  });

  it("resolves variant costs server-side with contract cost basis", () => {
    useFixtureDb();

    expect(resolveCatalogVariantCost("ss:3001-BLK-M")).toMatchObject({
      unitCost: 4.25,
      costBasis: "customerPrice",
      vendor: "ss",
      variantId: "ss:3001-BLK-M",
    });
    expect(resolveCatalogVariantCost("sanmar:K500-RED-L")).toMatchObject({
      unitCost: 9.75,
      costBasis: "piecePrice",
      vendor: "sanmar",
      variantId: "sanmar:K500-RED-L",
    });
  });
});
