import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../item/route";
import {
  getVendorCatalogStatus,
  resolveCatalogVariantCost,
} from "@/lib/server/vendor-catalog/repository";

vi.mock("@/lib/server/vendor-catalog/repository", () => ({
  getVendorCatalogStatus: vi.fn(),
  resolveCatalogVariantCost: vi.fn(),
}));

function request(body: unknown) {
  return new NextRequest(
    new Request("http://localhost/api/quote/item", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cmp-role": "staff" },
      body: JSON.stringify(body),
    })
  );
}

describe("quote item route discontinued catalog variants", () => {
  it("rejects discontinued catalogVariantId requests before pricing", async () => {
    vi.mocked(getVendorCatalogStatus).mockResolvedValue({ available: true });
    vi.mocked(resolveCatalogVariantCost).mockResolvedValue({
      variantId: "sanmar:K500-RED-XL",
      vendor: "sanmar",
      styleId: "sanmar:K500",
      styleCode: "K500",
      color: "Red",
      size: "XL",
      discontinued: true,
      unitCost: 9.25,
      costBasis: "casePrice",
      sourceSyncAt: "2026-06-29T00:00:00.000Z",
    });

    const response = await POST(
      request({ catalogVariantId: "sanmar:K500-RED-XL", quantity: 12 })
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
});
