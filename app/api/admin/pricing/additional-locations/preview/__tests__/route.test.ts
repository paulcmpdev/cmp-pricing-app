import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

const env = process.env as Record<string, string | undefined>;
const original = {
  NODE_ENV: env.NODE_ENV,
  VERCEL_ENV: env.VERCEL_ENV,
  CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW:
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW,
};

function request(url: string, init?: RequestInit) {
  return new NextRequest(new Request(url, init));
}

afterEach(() => {
  env.NODE_ENV = original.NODE_ENV;
  env.VERCEL_ENV = original.VERCEL_ENV;
  env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW =
    original.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW;
});

describe("admin additional locations matrix preview API", () => {
  it("returns 404 when disabled", async () => {
    env.NODE_ENV = "test";
    delete env.VERCEL_ENV;
    delete env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW;

    const { GET, POST } = await import("../route");

    const getResponse = await GET(
      request("http://localhost/api/admin/pricing/additional-locations/preview")
    );
    expect(getResponse.status).toBe(404);

    const postResponse = await POST(
      request("http://localhost/api/admin/pricing/additional-locations/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edits: {} }),
      })
    );
    expect(postResponse.status).toBe(404);
  });

  it("returns 404 for production even when flagged", async () => {
    env.NODE_ENV = "production";
    env.VERCEL_ENV = "production";
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW = "true";

    const { GET } = await import("../route");
    const response = await GET(
      request("http://localhost/api/admin/pricing/additional-locations/preview")
    );
    expect(response.status).toBe(404);
  });

  it("returns baseline with 104 rows when enabled", async () => {
    env.NODE_ENV = "test";
    delete env.VERCEL_ENV;
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW = "true";

    const { GET } = await import("../route");
    const response = await GET(
      request("http://localhost/api/admin/pricing/additional-locations/preview")
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.rows).toHaveLength(104);
    expect(data.marginLanes.T1).toBe(0.58);
    expect(data.isDirty).toBe(false);
  });

  it("accepts margin edits and returns recalculated draft", async () => {
    env.NODE_ENV = "test";
    delete env.VERCEL_ENV;
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW = "true";

    const { POST } = await import("../route");
    const response = await POST(
      request("http://localhost/api/admin/pricing/additional-locations/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edits: { T1: 60 } }),
      })
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.isDirty).toBe(true);
    expect(data.draftMargins.T1).toBe(0.6);
    expect(data.rows).toHaveLength(104);
  });

  it("rejects invalid margin values", async () => {
    env.NODE_ENV = "test";
    delete env.VERCEL_ENV;
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW = "true";

    const { POST } = await import("../route");
    const response = await POST(
      request("http://localhost/api/admin/pricing/additional-locations/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edits: { T1: 100 } }),
      })
    );
    expect(response.status).toBe(400);
  });

  it("rejects fractional decimal notation such as 0.58", async () => {
    env.NODE_ENV = "test";
    delete env.VERCEL_ENV;
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW = "true";

    const { POST } = await import("../route");
    const response = await POST(
      request("http://localhost/api/admin/pricing/additional-locations/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edits: { T1: 0.58 } }),
      })
    );
    expect(response.status).toBe(400);
  });

  it("accepts exactly 0 and percentage-point decimals from 1 through below 100", async () => {
    env.NODE_ENV = "test";
    delete env.VERCEL_ENV;
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW = "true";

    const { POST } = await import("../route");

    for (const value of [0, 1, 58.5]) {
      const response = await POST(
        request("http://localhost/api/admin/pricing/additional-locations/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ edits: { T1: value } }),
        })
      );
      expect(response.status).toBe(200);
    }
  });

  it("rejects malformed JSON", async () => {
    env.NODE_ENV = "test";
    delete env.VERCEL_ENV;
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW = "true";

    const { POST } = await import("../route");
    const response = await POST(
      request("http://localhost/api/admin/pricing/additional-locations/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      })
    );
    expect(response.status).toBe(400);
  });
});
