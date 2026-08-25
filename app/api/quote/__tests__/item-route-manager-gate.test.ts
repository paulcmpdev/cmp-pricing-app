import { describe, expect, it, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../item/route";

vi.mock("@/lib/server/vendor-catalog/repository", () => ({
  getVendorCatalogStatus: vi.fn(),
  resolveCatalogVariantCost: vi.fn(),
}));

const env = process.env as Record<string, string | undefined>;

function managerRequest(body: unknown) {
  return new NextRequest(
    new Request("http://localhost/api/quote/item", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cmp-role": "manager" },
      body: JSON.stringify(body),
    })
  );
}

function staffRequest(body: unknown) {
  return new NextRequest(
    new Request("http://localhost/api/quote/item", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

const validBody = { productCost: 3.95, quantity: 84 };

describe("item route manager gate", () => {
  const saved = {
    NODE_ENV: env.NODE_ENV,
    VERCEL_ENV: env.VERCEL_ENV,
    CMP_ALLOW_LOCAL_MANAGER_MODE: env.CMP_ALLOW_LOCAL_MANAGER_MODE,
    CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW:
      env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW,
  };

  afterEach(() => {
    env.NODE_ENV = saved.NODE_ENV;
    env.VERCEL_ENV = saved.VERCEL_ENV;
    env.CMP_ALLOW_LOCAL_MANAGER_MODE = saved.CMP_ALLOW_LOCAL_MANAGER_MODE;
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW =
      saved.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW;
  });

  it("server preview gate returns manager projection WITHOUT manager header", async () => {
    env.NODE_ENV = "production";
    env.VERCEL_ENV = "preview";
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW = "true";
    delete env.CMP_ALLOW_LOCAL_MANAGER_MODE;

    const res = await POST(staffRequest(validBody));
    const data = await res.json();

    expect(data.commissionReserve).toBeDefined();
    expect(data.totalProductionCogs).toBeDefined();
  });

  it("returns manager projection on Vercel preview when additional-locations flag is enabled", async () => {
    env.NODE_ENV = "production";
    env.VERCEL_ENV = "preview";
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW = "true";
    delete env.CMP_ALLOW_LOCAL_MANAGER_MODE;

    const res = await POST(managerRequest(validBody));
    const data = await res.json();

    expect(data.commissionReserve).toBeDefined();
    expect(data.totalProductionCogs).toBeDefined();
  });

  it("blocks manager projection on Vercel production even with additional-locations flag", async () => {
    env.NODE_ENV = "production";
    env.VERCEL_ENV = "production";
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW = "true";
    delete env.CMP_ALLOW_LOCAL_MANAGER_MODE;

    const res = await POST(managerRequest(validBody));
    const data = await res.json();

    expect(data.commissionReserve).toBeUndefined();
    expect(data.totalProductionCogs).toBeUndefined();
  });

  it("spoofed manager header without flag or local opt-in returns staff projection", async () => {
    env.NODE_ENV = "production";
    env.VERCEL_ENV = "preview";
    delete env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW;
    delete env.CMP_ALLOW_LOCAL_MANAGER_MODE;

    const res = await POST(managerRequest(validBody));
    const data = await res.json();

    expect(data.commissionReserve).toBeUndefined();
    expect(data.totalProductionCogs).toBeUndefined();
  });

  it("spoofed manager header on production returns staff projection", async () => {
    env.NODE_ENV = "production";
    env.VERCEL_ENV = "production";
    delete env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW;
    delete env.CMP_ALLOW_LOCAL_MANAGER_MODE;

    const res = await POST(managerRequest(validBody));
    const data = await res.json();

    expect(data.commissionReserve).toBeUndefined();
    expect(data.totalProductionCogs).toBeUndefined();
  });

  it("allows manager projection via local opt-in (existing behavior)", async () => {
    env.NODE_ENV = "development";
    delete env.VERCEL_ENV;
    env.CMP_ALLOW_LOCAL_MANAGER_MODE = "true";
    delete env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW;

    const res = await POST(managerRequest(validBody));
    const data = await res.json();

    expect(data.commissionReserve).toBeDefined();
    expect(data.totalProductionCogs).toBeDefined();
  });
});
