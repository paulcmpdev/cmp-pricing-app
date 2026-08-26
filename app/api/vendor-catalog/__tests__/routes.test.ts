import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVendorCatalogTestDb } from "@/tests/fixtures/vendor-catalog/build-test-db";
import { GET as searchGET } from "../search/route";
import { GET as variantsGET } from "../styles/[styleId]/variants/route";
import { POST as quoteItemPOST } from "@/app/api/quote/item/route";
import { POST as quoteFlatFeePOST } from "@/app/api/quote/flat-fee/route";
import { MANAGER_ONLY_FLAT_FEE_KEYS } from "@/lib/server/quote-types";

const originalPath = process.env.VENDOR_CATALOG_DB_PATH;
const originalDatabaseUrl = process.env.VENDOR_CATALOG_DATABASE_URL;
const tempDirs: string[] = [];

function useFixtureDb() {
  const dir = mkdtempSync(join(tmpdir(), "cmp-vendor-api-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "vendor-catalog.sqlite");
  buildVendorCatalogTestDb(dbPath);
  process.env.VENDOR_CATALOG_DB_PATH = dbPath;
  delete process.env.VENDOR_CATALOG_DATABASE_URL;
}

function request(url: string, init?: RequestInit) {
  return new NextRequest(new Request(url, init));
}

afterEach(() => {
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
    delete process.env.VENDOR_CATALOG_DATABASE_URL;

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
      { params: Promise.resolve({ styleId: "ss%3A3001" }) }
    );
    expect(variantResponse.status).toBe(200);
    const variantJson = await variantResponse.json();
    expect(variantJson.variants).toHaveLength(2);
    expect(JSON.stringify(variantJson)).not.toMatch(/cost|price|cogs/i);

    const sanmarVariantResponse = await variantsGET(
      request("http://localhost/api/vendor-catalog/styles/sanmar%3AK500/variants"),
      { params: Promise.resolve({ styleId: "sanmar%3AK500" }) }
    );
    expect(sanmarVariantResponse.status).toBe(200);
    const sanmarVariantJson = await sanmarVariantResponse.json();
    expect(sanmarVariantJson.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "sanmar:K500-RED-XL",
          discontinued: true,
        }),
      ])
    );
    expect(JSON.stringify(sanmarVariantJson)).not.toMatch(/cost|price|cogs/i);
  });
});

const env = process.env as Record<string, string | undefined>;

describe("vendor catalog quote API path", () => {
  const originalNodeEnv = env.NODE_ENV;
  const originalManagerMode = env.CMP_ALLOW_LOCAL_MANAGER_MODE;

  afterEach(() => {
    if (originalNodeEnv == null) {
      delete env.NODE_ENV;
    } else {
      env.NODE_ENV = originalNodeEnv;
    }
    if (originalManagerMode == null) {
      delete env.CMP_ALLOW_LOCAL_MANAGER_MODE;
    } else {
      env.CMP_ALLOW_LOCAL_MANAGER_MODE = originalManagerMode;
    }
  });

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

  it("rejects direct quote requests for discontinued catalog variants", async () => {
    useFixtureDb();

    const response = await quoteItemPOST(
      request("http://localhost/api/quote/item", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cmp-role": "staff" },
        body: JSON.stringify({
          catalogVariantId: "sanmar:K500-RED-XL",
          quantity: 12,
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        catalogVariantId: [
          "Catalog variant is discontinued and cannot be quoted.",
        ],
      },
    });
  });

  it("returns a graceful unavailable response for catalogVariantId without a database", async () => {
    delete process.env.VENDOR_CATALOG_DB_PATH;
    delete process.env.VENDOR_CATALOG_DATABASE_URL;

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

  it("adds catalog provenance to Manager response when local manager mode is enabled", async () => {
    useFixtureDb();
    env.NODE_ENV = "test";
    env.CMP_ALLOW_LOCAL_MANAGER_MODE = "true";

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
      unitCost: 9.25,
      costBasis: "casePrice",
      sourceSyncAt: "2026-06-29T00:00:00.000Z",
    });
  });

  it("production spoofing x-cmp-role: manager returns staff-safe JSON (no cost data)", async () => {
    useFixtureDb();
    env.NODE_ENV = "production";
    delete env.CMP_ALLOW_LOCAL_MANAGER_MODE;

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
    expect(json.salesPrice).toBeGreaterThan(0);
    // Must NOT include vendorCatalog provenance or any cost data
    expect(json.vendorCatalog).toBeUndefined();
    expect(JSON.stringify(json)).not.toMatch(/cost|basis|unitCost/i);
  });

  it("non-production without CMP_ALLOW_LOCAL_MANAGER_MODE still returns staff-safe JSON", async () => {
    useFixtureDb();
    env.NODE_ENV = "test";
    delete env.CMP_ALLOW_LOCAL_MANAGER_MODE;

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
    expect(json.vendorCatalog).toBeUndefined();
    expect(JSON.stringify(json)).not.toMatch(/cost|basis|unitCost/i);
  });
});

const FLAT_FEE_BODY = {
  service: "Additional Large Print",
  orderQuantity: 12,
};

describe("flat-fee quote API manager gate", () => {
  const originalNodeEnv = env.NODE_ENV;
  const originalManagerMode = env.CMP_ALLOW_LOCAL_MANAGER_MODE;

  afterEach(() => {
    if (originalNodeEnv == null) {
      delete env.NODE_ENV;
    } else {
      env.NODE_ENV = originalNodeEnv;
    }
    if (originalManagerMode == null) {
      delete env.CMP_ALLOW_LOCAL_MANAGER_MODE;
    } else {
      env.CMP_ALLOW_LOCAL_MANAGER_MODE = originalManagerMode;
    }
  });

  it("production spoofing x-cmp-role: manager returns staff-safe output (no COGS/margin)", async () => {
    env.NODE_ENV = "production";
    delete env.CMP_ALLOW_LOCAL_MANAGER_MODE;

    const response = await quoteFlatFeePOST(
      request("http://localhost/api/quote/flat-fee", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cmp-role": "manager" },
        body: JSON.stringify(FLAT_FEE_BODY),
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.effectivePrice).toBeGreaterThan(0);
    for (const key of MANAGER_ONLY_FLAT_FEE_KEYS) {
      expect(json).not.toHaveProperty(key);
    }
  });

  it("non-production with CMP_ALLOW_LOCAL_MANAGER_MODE=true returns manager output", async () => {
    env.NODE_ENV = "test";
    env.CMP_ALLOW_LOCAL_MANAGER_MODE = "true";

    const response = await quoteFlatFeePOST(
      request("http://localhost/api/quote/flat-fee", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cmp-role": "manager" },
        body: JSON.stringify(FLAT_FEE_BODY),
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    for (const key of MANAGER_ONLY_FLAT_FEE_KEYS) {
      expect(json).toHaveProperty(key);
    }
  });

  it("non-production without CMP_ALLOW_LOCAL_MANAGER_MODE returns staff-safe output", async () => {
    env.NODE_ENV = "test";
    delete env.CMP_ALLOW_LOCAL_MANAGER_MODE;

    const response = await quoteFlatFeePOST(
      request("http://localhost/api/quote/flat-fee", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cmp-role": "manager" },
        body: JSON.stringify(FLAT_FEE_BODY),
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.effectivePrice).toBeGreaterThan(0);
    for (const key of MANAGER_ONLY_FLAT_FEE_KEYS) {
      expect(json).not.toHaveProperty(key);
    }
  });
});
