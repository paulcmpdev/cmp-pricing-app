import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVendorCatalogTestDb } from "@/tests/fixtures/vendor-catalog/build-test-db";
import {
  getAdminCatalogOverview,
  getVendorCatalogStatus,
  resolveCatalogVariantCost,
  searchVendorCatalogStyles,
  getVendorCatalogStyleVariants,
  closeVendorCatalogPoolForTests,
} from "../repository";

const originalPath = process.env.VENDOR_CATALOG_DB_PATH;
const originalDatabaseUrl = process.env.VENDOR_CATALOG_DATABASE_URL;
const tempDirs: string[] = [];

function useFixtureDb() {
  const dir = mkdtempSync(join(tmpdir(), "cmp-vendor-catalog-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "vendor-catalog.sqlite");
  buildVendorCatalogTestDb(dbPath);
  process.env.VENDOR_CATALOG_DB_PATH = dbPath;
  delete process.env.VENDOR_CATALOG_DATABASE_URL;
  return dbPath;
}

afterEach(async () => {
  await closeVendorCatalogPoolForTests();
  if (originalDatabaseUrl == null) {
    delete process.env.VENDOR_CATALOG_DATABASE_URL;
  } else {
    process.env.VENDOR_CATALOG_DATABASE_URL = originalDatabaseUrl;
  }
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
  it("returns a generic unavailable admin overview when PostgreSQL is not configured", async () => {
    delete process.env.VENDOR_CATALOG_DB_PATH;
    delete process.env.VENDOR_CATALOG_DATABASE_URL;

    await expect(getAdminCatalogOverview()).resolves.toMatchObject({
      available: false,
      backend: "unconfigured",
      reason: "The vendor catalog overview is unavailable.",
      vendors: {
        ss: expect.objectContaining({ health: "unavailable" }),
        sanmar: expect.objectContaining({ health: "unavailable" }),
      },
      recentJobs: [],
      rollbackSummary: {
        ss: { totalCount: 0, latestAt: null },
        sanmar: { totalCount: 0, latestAt: null },
      },
      totals: { styleCount: 0, variantCount: 0, healthyVendorCount: 0 },
    });
  });

  it("returns a generic unavailable admin overview for SQLite-only configuration without leaking paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmp-vendor-catalog-admin-"));
    tempDirs.push(dir);
    const path = join(dir, "vendor-catalog.sqlite");
    writeFileSync(path, "");
    process.env.VENDOR_CATALOG_DB_PATH = path;
    delete process.env.VENDOR_CATALOG_DATABASE_URL;

    const overview = await getAdminCatalogOverview();

    expect(overview).toMatchObject({
      available: false,
      backend: "sqlite",
      reason: "The vendor catalog overview is unavailable.",
    });
    expect(JSON.stringify(overview)).not.toContain(path);
  });

  it("returns a generic unavailable admin overview when PostgreSQL fails", async () => {
    process.env.VENDOR_CATALOG_DATABASE_URL =
      "postgres://invalid:invalid@127.0.0.1:1/invalid";
    delete process.env.VENDOR_CATALOG_DB_PATH;

    const overview = await getAdminCatalogOverview();

    expect(overview).toMatchObject({
      available: false,
      backend: "postgres",
      reason: "The vendor catalog overview is unavailable.",
    });
  });

  it("reports graceful unavailable state when no SQLite path is configured", async () => {
    delete process.env.VENDOR_CATALOG_DB_PATH;
    delete process.env.VENDOR_CATALOG_DATABASE_URL;

    await expect(getVendorCatalogStatus()).resolves.toEqual({
      available: false,
      reason:
        "Neither VENDOR_CATALOG_DATABASE_URL nor VENDOR_CATALOG_DB_PATH is configured.",
    });
  });

  it("ranks exact style matches before prefix and substring matches", async () => {
    useFixtureDb();

    const results = await searchVendorCatalogStyles({ query: "3001", vendor: "all" });

    expect(results.map((style) => style.styleCode)).toEqual([
      "3001",
      "3001C",
      "B3001",
    ]);
  });

  it("returns public style and variant fields without monetary data", async () => {
    useFixtureDb();

    const [style] = await searchVendorCatalogStyles({ query: "K500", vendor: "sanmar" });
    const variants = await getVendorCatalogStyleVariants(style.id);

    expect(style).toMatchObject({
      id: "sanmar:K500",
      vendor: "sanmar",
      styleCode: "K500",
      brand: "Port Authority",
    });
    expect(Object.keys(style).join(" ")).not.toMatch(/cost|price|cogs/i);
    expect(variants).toHaveLength(3);
    expect(variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "sanmar:K500-RED-XL",
          discontinued: true,
        }),
      ])
    );
    for (const variant of variants) {
      expect(Object.keys(variant).join(" ")).not.toMatch(/cost|price|cogs/i);
    }
  });

  it("returns undefined for an unknown variant ID", async () => {
    useFixtureDb();

    await expect(
      resolveCatalogVariantCost("ss:does-not-exist")
    ).resolves.toBeUndefined();
  });

  it("resolves variant costs server-side with contract cost basis", async () => {
    useFixtureDb();

    await expect(resolveCatalogVariantCost("ss:3001-BLK-M")).resolves.toMatchObject({
      unitCost: 5.00,
      costBasis: "piecePrice",
      vendor: "ss",
      variantId: "ss:3001-BLK-M",
    });
    await expect(resolveCatalogVariantCost("sanmar:K500-RED-L")).resolves.toMatchObject({
      unitCost: 9.25,
      costBasis: "casePrice",
      vendor: "sanmar",
      variantId: "sanmar:K500-RED-L",
      discontinued: false,
    });
    await expect(resolveCatalogVariantCost("sanmar:K500-RED-XL")).resolves.toMatchObject({
      unitCost: 9.25,
      costBasis: "casePrice",
      vendor: "sanmar",
      variantId: "sanmar:K500-RED-XL",
      discontinued: true,
    });
  });
});
