import { test, expect } from "./fixtures";

/**
 * Auth-related Playwright tests.
 *
 * These run against the standard dev server (auth DISABLED) to verify:
 * 1. Existing unauthenticated local/E2E mode continues when auth flag is absent
 * 2. Login and unauthorized pages render correctly
 * 3. Auth-disabled API access works as before
 */

test.describe("Auth disabled (default E2E mode)", () => {
  test("unauthenticated user can access root Quote Desk", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /quote desk/i })
    ).toBeVisible({ timeout: 15000 });
  });

  test("unauthenticated user can access admin panel", async ({
    errorFreePage: page,
  }) => {
    const response = await page.goto("/admin");
    // Should load successfully (not redirect to login)
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "CATALOG OPERATIONS" })
    ).toBeVisible({ timeout: 30000 });
  });

  test("unauthenticated user can access admin pricing", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/admin/pricing");
    await expect(
      page.getByText("PRICING PREVIEW")
    ).toBeVisible({ timeout: 15000 });
  });

  test("unauthenticated user can access concepts", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts");
    await expect(page.getByText(/evaluation/i)).toBeVisible({
      timeout: 15000,
    });
  });

  test("quote API returns valid data without auth", async ({ request }) => {
    const response = await request.post("/api/quote/item", {
      data: { productCost: 3.95, quantity: 84 },
    });
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data.salesPrice).toBeGreaterThan(0);
  });

  test("flat-fee API returns valid data without auth", async ({ request }) => {
    const response = await request.post("/api/quote/flat-fee", {
      data: { service: "Sleeve Print", orderQuantity: 84 },
    });
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data.effectivePrice).toBeGreaterThan(0);
  });
});

test.describe("Login page", () => {
  test("login page renders with branded content", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/login");
    await expect(page.getByText("CMP PRICING")).toBeVisible({
      timeout: 10000,
    });
    await expect(
      page.getByText(/cmpsportswear\.com/i)
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /sign in with google/i })
    ).toBeVisible();
  });
});

test.describe("Unauthorized page", () => {
  test("unauthorized page renders with access restriction message", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/unauthorized");
    await expect(page.getByText("ACCESS RESTRICTED")).toBeVisible({
      timeout: 10000,
    });
    await expect(
      page.getByRole("link", { name: /go to quote desk/i })
    ).toBeVisible();
  });
});
