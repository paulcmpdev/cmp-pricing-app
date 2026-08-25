import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

import { getToken } from "next-auth/jwt";
import { GET as catalogGET } from "@/app/api/catalog/route";
import { GET as searchGET } from "@/app/api/vendor-catalog/search/route";
import { GET as variantsGET } from "@/app/api/vendor-catalog/styles/[styleId]/variants/route";

const mockGetToken = vi.mocked(getToken);
const env = process.env as Record<string, string | undefined>;
const originalAuthEnabled = env.CMP_AUTH_ENABLED;

function request(url: string) {
  return new NextRequest(new Request(url));
}

afterEach(() => {
  if (originalAuthEnabled === undefined) delete env.CMP_AUTH_ENABLED;
  else env.CMP_AUTH_ENABLED = originalAuthEnabled;
  vi.resetAllMocks();
});

describe("authenticated catalog API boundary", () => {
  it.each([
    ["catalog", () => catalogGET(request("http://localhost/api/catalog"))],
    [
      "vendor search",
      () => searchGET(request("http://localhost/api/vendor-catalog/search?q=ST400")),
    ],
    [
      "vendor variants",
      () =>
        variantsGET(
          request("http://localhost/api/vendor-catalog/styles/sanmar%3AST400/variants"),
          { params: Promise.resolve({ styleId: "sanmar%3AST400" }) }
        ),
    ],
  ])("returns 401 for unauthenticated %s requests", async (_name, invoke) => {
    env.CMP_AUTH_ENABLED = "true";
    mockGetToken.mockResolvedValue(null);

    const response = await invoke();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required." });
  });

  it("allows authenticated Sales Rep catalog access", async () => {
    env.CMP_AUTH_ENABLED = "true";
    mockGetToken.mockResolvedValue({
      email: "rep@cmpsportswear.com",
      role: "sales_rep",
    } as never);

    const response = await catalogGET(request("http://localhost/api/catalog"));

    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });
});
