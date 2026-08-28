import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../route";
import { getBaselineDtfMatrix } from "@/lib/server/pricing-config/baseline";

const env = process.env as Record<string, string | undefined>;
const original = {
  NODE_ENV: env.NODE_ENV,
  VERCEL_ENV: env.VERCEL_ENV,
  CMP_ENABLE_PRICING_PREVIEW: env.CMP_ENABLE_PRICING_PREVIEW,
};

function request(url: string, init?: RequestInit) {
  return new NextRequest(new Request(url, init));
}

function postBody(body: unknown, headers: Record<string, string> = {}) {
  return request("http://localhost/api/admin/pricing/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function streamingRequest(url: string, chunks: string[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function enable() {
  env.NODE_ENV = "test";
  delete env.VERCEL_ENV;
  env.CMP_ENABLE_PRICING_PREVIEW = "true";
}

afterEach(() => {
  env.NODE_ENV = original.NODE_ENV;
  env.VERCEL_ENV = original.VERCEL_ENV;
  env.CMP_ENABLE_PRICING_PREVIEW = original.CMP_ENABLE_PRICING_PREVIEW;
});

describe("admin pricing preview API", () => {
  it("returns not found when the preview is disabled", async () => {
    env.NODE_ENV = "test";
    delete env.VERCEL_ENV;
    delete env.CMP_ENABLE_PRICING_PREVIEW;

    const getResponse = await GET(
      request("http://localhost/api/admin/pricing/preview")
    );
    expect(getResponse.status).toBe(404);

    const postResponse = await POST(postBody({ draft: getBaselineDtfMatrix() }));
    expect(postResponse.status).toBe(404);
  });

  it("GET returns the baseline matrix with per-tier cost bases", async () => {
    enable();

    const response = await GET(
      request("http://localhost/api/admin/pricing/preview")
    );
    expect(response.status).toBe(200);

    const preview = await response.json();
    expect(preview.schemaVersion).toBe("1.0.0");
    expect(preview.tiers).toHaveLength(23);
    expect(preview.costBases["72:143"]).toBeDefined();
    expect(preview.tiers[0].costBasis.source).toBe("contract");
    expect(preview.dtfContext.maxSupportedQuantity).toBe(5000);
  });

  it("POST previews a full draft matrix with dynamic lane keys", async () => {
    enable();

    const response = await POST(
      postBody({
        draft: {
          lanes: [{ key: "RETAIL", label: "Retail", margin: 0.5, active: true }],
          tiers: [
            { tier: "All", minQty: 1, maxQty: null, prices: { RETAIL: 12.5 } },
          ],
        },
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.preview.tiers).toHaveLength(1);
    expect(data.preview.tiers[0].lanes.RETAIL.price).toBe("12.50");
    expect(data.quote).toBeUndefined();
  });

  it("POST compares the saved config against the draft for a quote", async () => {
    enable();

    const saved = getBaselineDtfMatrix();
    const draft = getBaselineDtfMatrix();
    const idx = draft.tiers.findIndex((t) => t.tier === "144-249");
    draft.tiers[idx].prices.T1 = saved.tiers[idx].prices.T1 + 2;

    const response = await POST(
      postBody({
        draft,
        current: saved,
        quote: { productCost: 4.8, quantity: 174, lane: "T1" },
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.quote.available).toBe(true);
    expect(data.quote.delta.unitPrice).toBe("2.00");
    expect(data.quote.delta.orderTotal).toBe("348.00");
    // Product Sell is untouched by a DTF lane edit.
    expect(data.quote.delta.productSell).toBe("0.00");
  });

  it("POST never leaks COGS beyond the admin-authorized cost basis", async () => {
    enable();

    const response = await POST(postBody({ draft: getBaselineDtfMatrix() }));
    const text = JSON.stringify(await response.json());

    // The cost basis IS intentionally returned to this admin-only route.
    expect(text).toMatch(/baseDtfCogs/);
    // But the raw contract fixture is not echoed wholesale.
    expect(text).not.toMatch(/sheetOptions/);
    expect(text).not.toMatch(/directLaborPerHour/);
  });

  it("rejects a malformed draft with a 400 instead of throwing", async () => {
    enable();

    const missingDraft = await POST(postBody({}));
    expect(missingDraft.status).toBe(400);

    const undeclaredLane = await POST(
      postBody({
        draft: {
          lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
          tiers: [
            { tier: "All", minQty: 1, maxQty: null, prices: { T1: 5, GHOST: 5 } },
          ],
        },
      })
    );
    expect(undeclaredLane.status).toBe(400);
  });

  it("rejects a quote quantity beyond the supported range", async () => {
    enable();

    const response = await POST(
      postBody({
        draft: getBaselineDtfMatrix(),
        quote: { productCost: 4.8, quantity: 5001, lane: "T1" },
      })
    );
    expect(response.status).toBe(400);
  });

  it("rejects declared oversized bodies before reading them", async () => {
    enable();

    const response = await POST(
      postBody(
        { draft: getBaselineDtfMatrix() },
        { "Content-Length": "65537" }
      )
    );
    expect(response.status).toBe(413);
  });

  it("caps streamed request bodies without trusting an absent content length", async () => {
    enable();

    const response = await POST(
      streamingRequest("http://localhost/api/admin/pricing/preview", [
        '{"draft":{},"padding":"',
        "x".repeat(65_537),
        '"}',
      ])
    );
    expect(response.status).toBe(413);
  });

  it("treats an empty body safely", async () => {
    enable();

    const response = await POST(
      request("http://localhost/api/admin/pricing/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );

    // No draft to preview — a validation error, never a crash.
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBeDefined();
  });

  it("treats malformed JSON safely", async () => {
    enable();

    const response = await POST(
      request("http://localhost/api/admin/pricing/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      })
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error._form[0]).toMatch(/Malformed JSON/);
  });

  it("accepts a full draft-plus-saved comparison body", async () => {
    enable();

    // The heaviest legal shape: two complete matrices plus a quote. This is
    // what the unified editor actually sends on every recalculation.
    const response = await POST(
      postBody({
        draft: getBaselineDtfMatrix(),
        current: getBaselineDtfMatrix(),
        quote: { productCost: 4.8, quantity: 174, lane: "T1" },
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.quote.available).toBe(true);
  });
});
