import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVendorCatalogTestDb } from "@/tests/fixtures/vendor-catalog/build-test-db";
import { GET as searchGET } from "../search/route";
import { GET as variantsGET } from "../styles/[styleId]/variants/route";
import { POST as quoteItemPOST } from "@/app/api/quote/item/route";

const originalPath = process.env.VENDOR_CATALOG_DB_PATH;
const tempDirs: string[] = [];

function useFixtureDb() {
  const dir = mkdtempSync(join(tmpdir(), "cmp-vendor-api-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "vendor-catalog.sqlite");
  buildVendorCatalogTestDb(dbPath);
  process.env.VENDOR_CATALOG_DB_PATH = dbPath;
}

function request(url: string, init?: RequestInit) {
  return new NextRequest(new Request(url, init));
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

describe("vendor catalog API", () => {
  it("rejects short search terms", async () => {
    const response = await searchGET(
      request("http://localhost/api/vendor-catalog/search?q=3")
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { q: ["Search requires at least two non-space characters."] },
    });
  });

  it("returns unavailable state without a configured database", async () => {
    delete process.env.VENDOR_CATALOG_DB_PATH;

    const response = await searchGET(
      request("http://localhost/api/vendor-catalog/search?q=3001")
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      available: false,
      error: "Vendor catalog is unavailable.",
    });
  });

  it("returns public search and variant JSON without costs", async () => {
    useFixtureDb();

    const searchResponse = await searchGET(
      request("http://localhost/api/vendor-catalog/search?q=3001&vendor=ss")
    );
    expect(searchResponse.status).toBe(200);
    const searchJson = await searchResponse.json();
    expect(searchJson.results[0].id).toBe("ss:3001");
    expect(JSON.stringify(searchJson)).not.toMatch(/cost|price|cogs/i);

    const variantResponse = await variantsGET(
      request("http://localhost/api/vendor-catalog/styles/ss%3A3001/variants"),
      { params: { styleId: "ss%3A3001" } }
    );
    expect(variantResponse.status).toBe(200);
    const variantJson = await variantResponse.json();
    expect(variantJson.variants).toHaveLength(2);
    expect(JSON.stringify(variantJson)).not.toMatch(/cost|price|cogs/i);
  });
});

describe("vendor catalog quote API path", () => {
  it("requires sku, productCost, and catalogVariantId to be mutually exclusive", async () => {
    useFixtureDb();

    const response = await quoteItemPOST(
      request("http://localhost/api/quote/item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku: "ST400",
          catalogVariantId: "ss:3001-BLK-M",
          quantity: 12,
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        _form: ["Choose exactly one of sku, productCost, or catalogVariantId."],
      },
    });
  });

  it("resolves catalogVariantId server-side and hides cost from Staff", async () => {
    useFixtureDb();

    const response = await quoteItemPOST(
      request("http://localhost/api/quote/item", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cmp-role": "staff" },
        body: JSON.stringify({
          catalogVariantId: "ss:3001-BLK-M",
          quantity: 12,
        }),
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.salesPrice).toBeGreaterThan(0);
    expect(JSON.stringify(json)).not.toMatch(/cost|basis|vendor|variant/i);
  });

  it("returns a graceful unavailable response for catalogVariantId without a database", async () => {
    delete process.env.VENDOR_CATALOG_DB_PATH;

    const response = await quoteItemPOST(
      request("http://localhost/api/quote/item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalogVariantId: "ss:3001-BLK-M",
          quantity: 12,
        }),
      })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: {
        catalogVariantId: ["Vendor catalog is unavailable."],
      },
    });
  });

  it("adds catalog provenance only to Manager quote responses", async () => {
    useFixtureDb();

    const response = await quoteItemPOST(
      request("http://localhost/api/quote/item", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cmp-role": "manager" },
        body: JSON.stringify({
          catalogVariantId: "sanmar:K500-RED-L",
          quantity: 12,
        }),
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.vendorCatalog).toEqual({
      vendor: "sanmar",
      variantId: "sanmar:K500-RED-L",
      styleId: "sanmar:K500",
      styleCode: "K500",
      color: "Red",
      size: "L",
      unitCost: 9.75,
      costBasis: "piecePrice",
      sourceSyncAt: "2026-06-29T00:00:00.000Z",
    });
  });
});
