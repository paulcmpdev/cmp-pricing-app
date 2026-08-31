import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { encode } from "next-auth/jwt";

const BASE_URL = "http://127.0.0.1:3101";
const AUTH_TEST_SECRET = "cmp-auth-e2e-secret-with-at-least-thirty-two-characters";

type TestRole = "sales_rep" | "manager" | "admin";

async function authenticate(
  context: BrowserContext,
  email: string,
  role: TestRole
) {
  const token = await encode({
    secret: AUTH_TEST_SECRET,
    maxAge: 60 * 60,
    token: {
      sub: email,
      email,
      name: email.split("@")[0],
      role,
    },
  });

  await context.addCookies([
    {
      name: "next-auth.session-token",
      value: token,
      url: BASE_URL,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

async function enterManualQuote(page: Page) {
  await page.getByRole("button", { name: "Manual Cost" }).click();
  await page.locator("#manual-cost").fill("3.95");
  await expect(page.getByText("Product Sell").first()).toBeVisible({ timeout: 10_000 });
}

test.describe("authenticated production boundary", () => {
  test("unauthenticated pages redirect to login and APIs return 401", async ({ page, request }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login\?callbackUrl=%2F$/);
    await expect(page.getByRole("button", { name: /sign in with google/i })).toBeVisible();

    const response = await request.post("/api/quote/item", {
      data: { productCost: 3.95, quantity: 84 },
    });
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required." });
  });

  test("Sales Rep sees Additional Locations but cannot see COGS or Admin", async ({
    context,
    page,
  }) => {
    await authenticate(context, "rep@cmpsportswear.com", "sales_rep");
    await page.goto("/");

    await expect(page.getByTestId("user-email")).toHaveText("rep@cmpsportswear.com");
    await expect(page.getByTestId("user-role")).toHaveText("Sales Rep");
    await expect(page.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /additional locations/i })).toBeVisible();

    await enterManualQuote(page);
    await page.getByTestId("add-location-btn").click();
    await page.locator("[data-testid^='location-row-'] select").selectOption("Sleeve Print");
    await expect(page.locator("[data-testid^='location-row-']").getByText(/\$/)).toBeVisible();
    await expect(page.getByTestId("cogs-breakdown")).toHaveCount(0);
    await expect(page.getByText("Product COGS", { exact: true })).toHaveCount(0);

    await page.goto("/admin");
    await expect(page).toHaveURL(/\/unauthorized$/);
    await expect(page.getByText("ACCESS RESTRICTED")).toBeVisible();
  });

  test("spoofed Manager header cannot elevate an authenticated Sales Rep", async ({
    context,
  }) => {
    await authenticate(context, "rep@cmpsportswear.com", "sales_rep");

    const response = await context.request.post("/api/quote/item", {
      headers: { "x-cmp-role": "manager" },
      data: { productCost: 3.95, quantity: 84 },
    });
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data.salesPrice).toBeGreaterThan(0);
    expect(data.totalProductionCogs).toBeUndefined();
    expect(data.commissionReserve).toBeUndefined();
    expect(data.vendorCatalog).toBeUndefined();
  });

  test("Manager receives internal quote projection but cannot enter Admin", async ({
    context,
    page,
  }) => {
    await authenticate(context, "manager@cmpsportswear.com", "manager");
    await page.goto("/");
    await enterManualQuote(page);
    await expect(page.getByTestId("cogs-breakdown")).toBeVisible();

    await page.goto("/admin/pricing");
    await expect(page).toHaveURL(/\/unauthorized$/);
  });

  test("Admin sees Additional Locations, internal COGS, and Admin Pricing", async ({
    context,
    page,
  }) => {
    await authenticate(context, "paul@cmpsportswear.com", "admin");
    await page.goto("/");

    await expect(page.getByTestId("user-role")).toHaveText("Admin");
    await expect(page.getByRole("heading", { name: /additional locations/i })).toBeVisible();
    await enterManualQuote(page);
    await expect(page.getByTestId("cogs-breakdown")).toBeVisible();

    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "CATALOG OPERATIONS" })).toBeVisible();
    await page.goto("/admin/pricing");
    await expect(page.getByText("PRICING PREVIEW")).toBeVisible();
    await expect(
      page.getByText("Authenticated production · Persistent pricing").first()
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "DTF Pricing Matrix" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Additional Prints / DTF Flat Fees" })
    ).toBeVisible();
  });

  test("sign out removes the authenticated session", async ({ context, page }) => {
    await authenticate(context, "paul@cmpsportswear.com", "admin");
    await page.goto("/");
    await page.getByTestId("sign-out-btn").click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto("/");
    await expect(page).toHaveURL(/\/login\?callbackUrl=%2F$/);
  });
});
