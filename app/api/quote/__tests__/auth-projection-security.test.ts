import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as quoteItemPOST } from "../item/route";
import { GET as quoteOptionsGET } from "../options/route";
import { POST as quoteFlatFeePOST } from "../flat-fee/route";
import {
  MANAGER_ONLY_ITEM_KEYS,
  MANAGER_ONLY_FLAT_FEE_KEYS,
} from "@/lib/server/quote-types";

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

vi.mock("@/lib/server/vendor-catalog/repository", () => ({
  getVendorCatalogStatus: vi.fn(),
  resolveCatalogVariantCost: vi.fn(),
}));

import { getToken } from "next-auth/jwt";
const mockGetToken = vi.mocked(getToken);

const env = process.env as Record<string, string | undefined>;

const KEYS = [
  "CMP_AUTH_ENABLED",
  "CMP_ALLOWED_GOOGLE_DOMAIN",
  "CMP_ADMIN_EMAILS",
  "CMP_MANAGER_EMAILS",
  "CMP_ALLOW_LOCAL_MANAGER_MODE",
  "CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW",
  "NODE_ENV",
  "VERCEL_ENV",
] as const;

const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
  vi.resetAllMocks();
});

function enableAuth() {
  env.CMP_AUTH_ENABLED = "true";
  env.CMP_ALLOWED_GOOGLE_DOMAIN = "cmpsportswear.com";
  env.CMP_ADMIN_EMAILS = "paul@cmpsportswear.com";
  env.CMP_MANAGER_EMAILS = "jane@cmpsportswear.com";
  delete env.CMP_ALLOW_LOCAL_MANAGER_MODE;
  delete env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW;
}

function makeRequest(url: string, body: unknown, extraHeaders?: Record<string, string>) {
  return new NextRequest(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    })
  );
}

const ITEM_BODY = { productCost: 3.95, quantity: 84 };
const FLAT_FEE_BODY = { service: "sleeve_print", orderQuantity: 84 };

// Sensitive field patterns that must never appear in sales_rep responses
const SENSITIVE_PATTERNS = /productCost|vendorCost|unitCost|cogs|wages|commission|contribution|costBasis|provenance/i;

describe("auth-enabled quote projection security", () => {
  describe("item quote route", () => {
    it("returns 401 when auth is enabled without a session", async () => {
      enableAuth();
      mockGetToken.mockResolvedValue(null);

      const res = await quoteItemPOST(
        makeRequest("http://localhost/api/quote/item", ITEM_BODY)
      );

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Authentication required." });
    });

    it("sales_rep receives staff projection with NO cost/COGS data", async () => {
      enableAuth();
      mockGetToken.mockResolvedValue({
        email: "rep@cmpsportswear.com",
        role: "sales_rep",
      } as any);

      const res = await quoteItemPOST(
        makeRequest("http://localhost/api/quote/item", ITEM_BODY)
      );
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.salesPrice).toBeGreaterThan(0);
      for (const key of MANAGER_ONLY_ITEM_KEYS) {
        expect(data).not.toHaveProperty(key);
      }
    });

    it("rejects a sales_rep pricing-lane override", async () => {
      enableAuth();
      mockGetToken.mockResolvedValue({
        email: "rep@cmpsportswear.com",
        role: "sales_rep",
      } as any);

      const res = await quoteItemPOST(
        makeRequest("http://localhost/api/quote/item", {
          ...ITEM_BODY,
          tierPriceLane: "T2",
        })
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Insufficient permissions." });
    });

    it.each(["manager", "admin"] as const)(
      "allows a %s pricing-lane override",
      async (role) => {
        enableAuth();
        mockGetToken.mockResolvedValue({
          email: `${role}@cmpsportswear.com`,
          role,
        } as any);

        const res = await quoteItemPOST(
          makeRequest("http://localhost/api/quote/item", {
            ...ITEM_BODY,
            tierPriceLane: "T2",
          })
        );

        expect(res.status).toBe(200);
      }
    );

    it("admin receives manager projection with COGS data", async () => {
      enableAuth();
      mockGetToken.mockResolvedValue({
        email: "paul@cmpsportswear.com",
        role: "admin",
      } as any);

      const res = await quoteItemPOST(
        makeRequest("http://localhost/api/quote/item", ITEM_BODY)
      );
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.totalProductionCogs).toBeDefined();
      expect(data.commissionReserve).toBeDefined();
    });

    it("manager receives manager projection", async () => {
      enableAuth();
      mockGetToken.mockResolvedValue({
        email: "jane@cmpsportswear.com",
        role: "manager",
      } as any);

      const res = await quoteItemPOST(
        makeRequest("http://localhost/api/quote/item", ITEM_BODY)
      );
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.totalProductionCogs).toBeDefined();
    });

    it("spoofed x-cmp-role header does NOT elevate sales_rep", async () => {
      enableAuth();
      mockGetToken.mockResolvedValue({
        email: "rep@cmpsportswear.com",
        role: "sales_rep",
      } as any);

      const res = await quoteItemPOST(
        makeRequest("http://localhost/api/quote/item", ITEM_BODY, {
          "x-cmp-role": "manager",
        })
      );
      const data = await res.json();

      expect(res.status).toBe(200);
      for (const key of MANAGER_ONLY_ITEM_KEYS) {
        expect(data).not.toHaveProperty(key);
      }
    });

    it("sales_rep response JSON contains no sensitive field patterns", async () => {
      enableAuth();
      mockGetToken.mockResolvedValue({
        email: "rep@cmpsportswear.com",
        role: "sales_rep",
      } as any);

      const res = await quoteItemPOST(
        makeRequest("http://localhost/api/quote/item", ITEM_BODY)
      );
      const raw = JSON.stringify(await res.json());

      expect(raw).not.toMatch(SENSITIVE_PATTERNS);
    });
  });

  describe("quote options route", () => {
    it.each([
      ["sales_rep", false],
      ["manager", true],
      ["admin", true],
    ] as const)(
      "returns the authoritative override permission for %s projection",
      async (role, canOverridePricingLane) => {
        enableAuth();
        mockGetToken.mockResolvedValue({
          email: `${role}@cmpsportswear.com`,
          role,
        } as any);

        const res = await quoteOptionsGET(
          new NextRequest("http://localhost/api/quote/options")
        );
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.canOverridePricingLane).toBe(canOverridePricingLane);
      }
    );
  });

  describe("flat-fee quote route", () => {
    it("returns 401 when auth is enabled without a session", async () => {
      enableAuth();
      mockGetToken.mockResolvedValue(null);

      const res = await quoteFlatFeePOST(
        makeRequest("http://localhost/api/quote/flat-fee", FLAT_FEE_BODY)
      );

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Authentication required." });
    });

    it("sales_rep receives staff projection with NO COGS/margin data", async () => {
      enableAuth();
      mockGetToken.mockResolvedValue({
        email: "rep@cmpsportswear.com",
        role: "sales_rep",
      } as any);

      const res = await quoteFlatFeePOST(
        makeRequest("http://localhost/api/quote/flat-fee", FLAT_FEE_BODY)
      );
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.effectivePrice).toBeGreaterThan(0);
      for (const key of MANAGER_ONLY_FLAT_FEE_KEYS) {
        expect(data).not.toHaveProperty(key);
      }
    });

    it("admin receives manager projection with COGS/margin data", async () => {
      enableAuth();
      mockGetToken.mockResolvedValue({
        email: "paul@cmpsportswear.com",
        role: "admin",
      } as any);

      const res = await quoteFlatFeePOST(
        makeRequest("http://localhost/api/quote/flat-fee", FLAT_FEE_BODY)
      );
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.engineCogs).toBeDefined();
      expect(data.grossMargin).toBeDefined();
    });

    it("spoofed x-cmp-role header does NOT elevate sales_rep to get COGS", async () => {
      enableAuth();
      mockGetToken.mockResolvedValue({
        email: "rep@cmpsportswear.com",
        role: "sales_rep",
      } as any);

      const res = await quoteFlatFeePOST(
        makeRequest("http://localhost/api/quote/flat-fee", FLAT_FEE_BODY, {
          "x-cmp-role": "manager",
        })
      );
      const data = await res.json();

      expect(res.status).toBe(200);
      for (const key of MANAGER_ONLY_FLAT_FEE_KEYS) {
        expect(data).not.toHaveProperty(key);
      }
    });
  });
});
