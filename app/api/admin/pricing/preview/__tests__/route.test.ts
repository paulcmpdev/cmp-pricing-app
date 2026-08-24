import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../route";

const env = process.env as Record<string, string | undefined>;
const original = {
  NODE_ENV: env.NODE_ENV,
  VERCEL_ENV: env.VERCEL_ENV,
  CMP_ENABLE_PRICING_PREVIEW: env.CMP_ENABLE_PRICING_PREVIEW,
};

function request(url: string, init?: RequestInit) {
  return new NextRequest(new Request(url, init));
}

afterEach(() => {
  env.NODE_ENV = original.NODE_ENV;
  env.VERCEL_ENV = original.VERCEL_ENV;
  env.CMP_ENABLE_PRICING_PREVIEW = original.CMP_ENABLE_PRICING_PREVIEW;
});

describe("admin pricing preview API", () => {
  it("returns not found when disabled", async () => {
    env.NODE_ENV = "test";
    delete env.VERCEL_ENV;
    delete env.CMP_ENABLE_PRICING_PREVIEW;

    const getResponse = await GET();
    expect(getResponse.status).toBe(404);

    const postResponse = await POST(
      request("http://localhost/api/admin/pricing/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edits: [] }),
      })
    );
    expect(postResponse.status).toBe(404);
  });

  it("returns baseline and calculated draft only when enabled", async () => {
    env.NODE_ENV = "test";
    delete env.VERCEL_ENV;
    env.CMP_ENABLE_PRICING_PREVIEW = "true";

    const getResponse = await GET();
    expect(getResponse.status).toBe(200);
    const baseline = await getResponse.json();
    expect(baseline.tiers).toHaveLength(23);
    expect(JSON.stringify(baseline)).toMatch(/activeTotalDtfCogs/);

    const postResponse = await POST(
      request("http://localhost/api/admin/pricing/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          edits: [{ tier: "72-143", lane: "T4", marginPercent: 50 }],
          quote: { productCost: 4.8, quantity: 174, lane: "T1" },
        }),
      })
    );
    expect(postResponse.status).toBe(200);
    const draft = await postResponse.json();
    expect(draft.preview.tiers).toHaveLength(23);
    expect(draft.quote.current.orderTotal).toBe("2714.40");
  });

  it("validates payloads and caps body size", async () => {
    env.NODE_ENV = "test";
    delete env.VERCEL_ENV;
    env.CMP_ENABLE_PRICING_PREVIEW = "true";

    const invalidResponse = await POST(
      request("http://localhost/api/admin/pricing/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          edits: [{ tier: "72-143", lane: "T5", marginPercent: 35 }],
        }),
      })
    );
    expect(invalidResponse.status).toBe(400);

    const oversizedResponse = await POST(
      request("http://localhost/api/admin/pricing/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edits: [], padding: "x".repeat(20_000) }),
      })
    );
    expect(oversizedResponse.status).toBe(413);
  });
});
