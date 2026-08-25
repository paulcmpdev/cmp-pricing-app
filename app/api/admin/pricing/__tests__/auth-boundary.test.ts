import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

import { getToken } from "next-auth/jwt";
import {
  GET as pricingGET,
  POST as pricingPOST,
} from "../preview/route";
import {
  GET as locationsGET,
  POST as locationsPOST,
} from "../additional-locations/preview/route";

const mockGetToken = vi.mocked(getToken);
const env = process.env as Record<string, string | undefined>;
const original = {
  NODE_ENV: env.NODE_ENV,
  VERCEL_ENV: env.VERCEL_ENV,
  CMP_AUTH_ENABLED: env.CMP_AUTH_ENABLED,
  CMP_ENABLE_PRICING_PREVIEW: env.CMP_ENABLE_PRICING_PREVIEW,
  CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW:
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW,
};

function request(url: string, init?: RequestInit) {
  return new NextRequest(new Request(url, init));
}

const pricingRequest = () =>
  request("http://localhost/api/admin/pricing/preview");
const pricingPostRequest = () =>
  request("http://localhost/api/admin/pricing/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ edits: [] }),
  });
const locationsRequest = () =>
  request("http://localhost/api/admin/pricing/additional-locations/preview");
const locationsPostRequest = () =>
  request("http://localhost/api/admin/pricing/additional-locations/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ edits: {} }),
  });

beforeEach(() => {
  env.NODE_ENV = "test";
  delete env.VERCEL_ENV;
  env.CMP_AUTH_ENABLED = "true";
  env.CMP_ENABLE_PRICING_PREVIEW = "true";
  env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW = "true";
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  vi.resetAllMocks();
});

describe("auth-enabled Admin pricing API boundary", () => {
  it.each([
    ["pricing GET", () => pricingGET(pricingRequest())],
    ["pricing POST", () => pricingPOST(pricingPostRequest())],
    ["locations GET", () => locationsGET(locationsRequest())],
    ["locations POST", () => locationsPOST(locationsPostRequest())],
  ])("returns 401 for unauthenticated %s", async (_name, invoke) => {
    mockGetToken.mockResolvedValue(null);

    const response = await invoke();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required." });
  });

  it.each(["sales_rep", "manager"] as const)(
    "returns 403 for authenticated %s users on both Admin APIs",
    async (role) => {
      mockGetToken.mockResolvedValue({
        email: `${role}@cmpsportswear.com`,
        role,
      } as never);

      for (const invoke of [
        () => pricingGET(pricingRequest()),
        () => pricingPOST(pricingPostRequest()),
        () => locationsGET(locationsRequest()),
        () => locationsPOST(locationsPostRequest()),
      ]) {
        const response = await invoke();
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: "Insufficient permissions.",
        });
      }
    }
  );

  it("allows an authenticated Admin to use both preview APIs", async () => {
    mockGetToken.mockResolvedValue({
      email: "paul@cmpsportswear.com",
      role: "admin",
    } as never);

    const pricingResponse = await pricingGET(pricingRequest());
    expect(pricingResponse.status).toBe(200);
    expect((await pricingResponse.json()).tiers).toHaveLength(23);

    const locationsResponse = await locationsGET(locationsRequest());
    expect(locationsResponse.status).toBe(200);
    expect((await locationsResponse.json()).rows).toHaveLength(104);
  });
});
