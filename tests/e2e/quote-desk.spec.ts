import { test, expect } from "./fixtures";

/** Helper: wait for the item quote to load by checking for salesPrice text. */
async function waitForItemQuote(page: import("@playwright/test").Page) {
  await expect(
    page.getByText("Product Sell").first()
  ).toBeVisible({ timeout: 10000 });
}

/** Helper: wait for flat-fee quote to appear. */
async function waitForFlatFeeQuote(page: import("@playwright/test").Page) {
  await expect(
    page.getByText("Billable Quantity").first()
  ).toBeVisible({ timeout: 10000 });
}

test.describe("Quote Desk", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/concepts/quote-desk");
  });

  test("catalog selection changes Product Sell and Sales Price", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");

    // Select first product (ST400)
    await page.locator("#product-select").selectOption("ST400");
    await waitForItemQuote(page);

    // Capture initial values
    const productSell1 = await page
      .getByText("Product Sell")
      .first()
      .locator("..")
      .textContent();
    const salesPrice1 = await page
      .locator("[aria-label^='Per-item price']")
      .first()
      .textContent();

    // Switch to a different product (PC90H - fleece hoodie, higher cost)
    await page.locator("#product-select").selectOption("PC90H");
    await page.waitForTimeout(500); // debounce
    await waitForItemQuote(page);

    const productSell2 = await page
      .getByText("Product Sell")
      .first()
      .locator("..")
      .textContent();
    const salesPrice2 = await page
      .locator("[aria-label^='Per-item price']")
      .first()
      .textContent();

    // Values should have changed
    expect(productSell2).not.toEqual(productSell1);
    expect(salesPrice2).not.toEqual(salesPrice1);
  });

  test("manual Product Cost replaces catalog cost", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");

    // Switch to manual mode
    await page.getByRole("button", { name: "Manual Cost" }).click();

    // Enter manual cost
    await page.locator("#manual-cost").fill("3.95");
    await page.waitForTimeout(500);
    await waitForItemQuote(page);

    // Should show pricing with manual cost
    const salesPrice = await page
      .locator("[aria-label^='Per-item price']")
      .first()
      .textContent();
    expect(salesPrice).toBeTruthy();
    expect(salesPrice).toMatch(/^\$/);
  });

  test("quantity changes outputs", async ({ errorFreePage: page }) => {
    await page.goto("/concepts/quote-desk");

    await page.locator("#product-select").selectOption("ST400");
    await waitForItemQuote(page);

    // Get initial order total
    const orderTotal1 = await page
      .locator("[aria-label^='Order total']")
      .first()
      .textContent();

    // Change quantity
    await page.locator("#quantity-input").fill("200");
    await page.waitForTimeout(500);
    await waitForItemQuote(page);

    const orderTotal2 = await page
      .locator("[aria-label^='Order total']")
      .first()
      .textContent();

    expect(orderTotal2).not.toEqual(orderTotal1);
  });

  test("flat-fee selection changes outputs", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");

    await page.locator("#product-select").selectOption("ST400");
    await waitForItemQuote(page);

    const orderTotal1 = await page
      .locator("[aria-label^='Order total']")
      .first()
      .textContent();

    // Select a flat-fee service
    await page.locator("#service-select").selectOption("Sleeve Print");
    await waitForFlatFeeQuote(page);

    // Order total should now include add-on
    await expect(page.getByText("Items + Add-On").first()).toBeVisible();
    const orderTotal2 = await page
      .locator("[aria-label^='Order total']")
      .first()
      .textContent();
    expect(orderTotal2).not.toEqual(orderTotal1);
  });

  test("Manager toggle exposes internal details", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");

    await page.locator("#product-select").selectOption("ST400");
    await waitForItemQuote(page);

    // In staff mode, internal details should not be visible
    await expect(page.getByText("Internal Details").first()).not.toBeVisible();

    // Toggle to manager
    await page.getByRole("switch", { name: "Toggle Manager mode" }).click();
    await page.waitForTimeout(500);
    await waitForItemQuote(page);

    // Internal details now visible
    await expect(page.getByText("Internal Details").first()).toBeVisible();
    await expect(page.getByText("Commission Reserve").first()).toBeVisible();
    await expect(page.getByText("Decoration COGS").first()).toBeVisible();
    await expect(page.getByText("Gross Margin").first()).toBeVisible();
  });

  test("extra labor changes COGS/price/margin (flat-fee)", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");

    // Enable manager mode
    await page.getByRole("switch", { name: "Toggle Manager mode" }).click();

    // Select a product and flat-fee service
    await page.locator("#product-select").selectOption("ST400");
    await page.locator("#service-select").selectOption("Sleeve Print");
    await waitForFlatFeeQuote(page);

    // Capture baseline internal details
    const cogs1 = await page.getByText("Engine COGS").first().locator("..").textContent();
    const margin1 = await page.getByText("Gross Margin").nth(1).locator("..").textContent();

    // Add extra operator labor
    await page.locator("#extra-op-min").fill("2");
    await page.waitForTimeout(500);
    await waitForFlatFeeQuote(page);

    const cogs2 = await page.getByText("Engine COGS").first().locator("..").textContent();
    const margin2 = await page.getByText("Gross Margin").nth(1).locator("..").textContent();

    // COGS should increase, margin should decrease
    expect(cogs2).not.toEqual(cogs1);
    expect(margin2).not.toEqual(margin1);
  });

  test("decimal quantity shows validation error", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");

    await page.locator("#quantity-input").fill("84.5");

    await expect(
      page.getByRole("alert").filter({ hasText: "whole number" })
    ).toBeVisible();
  });

  test(">5000 shows manager review required, not an error", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");

    // First get a valid quote
    await page.locator("#product-select").selectOption("ST400");
    await waitForItemQuote(page);

    // Now enter qty beyond tier matrix range
    await page.locator("#quantity-input").fill("5001");
    await page.waitForTimeout(500);

    // Should show manager-review banner, not an error
    await expect(
      page.getByTestId("manager-review-banner")
    ).toBeVisible({ timeout: 10000 });

    await expect(
      page.getByTestId("manager-review-banner")
    ).toContainText("Manager review required");

    // No error alert should be present
    await expect(
      page.locator("[role='alert']").filter({ hasText: /error|HTTP|tier/i })
    ).not.toBeVisible();
  });
});
