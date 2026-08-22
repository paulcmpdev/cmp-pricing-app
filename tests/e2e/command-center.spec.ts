import { test, expect } from "./fixtures";

/** Helper: wait for the headline price to appear. */
async function waitForHeadlinePrice(page: import("@playwright/test").Page) {
  await expect(
    page.locator("[aria-label^='Per-item price']").first()
  ).toBeVisible({ timeout: 10000 });
}

test.describe("Command Center", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/concepts/command-center");
  });

  test("produces same engine-backed result for identical inputs as Quote Desk", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/command-center");

    // Command Center: select ST400, qty 84
    await page.locator("#cc-product-select").selectOption("ST400");
    await waitForHeadlinePrice(page);

    // Capture the per-item price
    const ccPrice = await page
      .locator("[aria-label^='Per-item price']")
      .first()
      .textContent();

    // Now go to Quote Desk with the same inputs
    await page.goto("/concepts/quote-desk");
    await page.locator("#product-select").selectOption("ST400");
    // Default qty is 84 in both
    await expect(
      page.locator("[aria-label^='Per-item price']").first()
    ).toBeVisible({ timeout: 10000 });

    const qdPrice = await page
      .locator("[aria-label^='Per-item price']")
      .first()
      .textContent();

    // Prices must match since they use the same engine
    expect(ccPrice).toEqual(qdPrice);
  });

  test("Manager audit panel works", async ({ errorFreePage: page }) => {
    await page.goto("/concepts/command-center");

    // Select a product to get a quote
    await page.locator("#cc-product-select").selectOption("ST400");
    await waitForHeadlinePrice(page);

    // In staff mode, no audit panel
    await expect(page.getByText("Manager Audit Panel")).not.toBeVisible();

    // Toggle to manager
    await page.getByRole("switch", { name: "Toggle Manager mode" }).click();
    await page.waitForTimeout(500);
    await waitForHeadlinePrice(page);

    // Audit panel should auto-open with manager mode
    await expect(page.getByText("Manager Audit Panel")).toBeVisible();

    // Check item internals are visible
    await expect(page.getByText("Item Internals")).toBeVisible();
    await expect(page.getByText("Commission Reserve").first()).toBeVisible();
    await expect(page.getByText("Decoration COGS").first()).toBeVisible();
    await expect(page.getByText("Total Production COGS").first()).toBeVisible();
    await expect(page.getByText("Gross Profit").first()).toBeVisible();

    // Collapse audit panel
    await page
      .getByRole("button", { name: /Manager Audit Panel/i })
      .click();

    // Item Internals should be hidden (panel collapsed)
    await expect(page.getByText("Item Internals")).not.toBeVisible();

    // Re-expand
    await page
      .getByRole("button", { name: /Manager Audit Panel/i })
      .click();
    await expect(page.getByText("Item Internals")).toBeVisible();
  });

  test("quantity changes update headline price", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/command-center");

    await page.locator("#cc-product-select").selectOption("ST400");
    await waitForHeadlinePrice(page);

    const totalLocator = page
      .locator("[aria-label^='Order total']")
      .first();
    const total1 = await totalLocator.textContent();

    await page.locator("#cc-quantity").fill("200");

    // Wait for the order total to change (debounce + API round-trip)
    await expect(totalLocator).not.toHaveText(total1!, { timeout: 10000 });
  });

  test("flat-fee selection updates order total", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/command-center");

    await page.locator("#cc-product-select").selectOption("ST400");
    await waitForHeadlinePrice(page);

    // Select a flat-fee service
    await page.locator("#cc-service-select").selectOption("Name");
    await page.waitForTimeout(500);

    // Wait for add-on line to appear in the headline
    await expect(page.getByText("Add-On").first()).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText("Items + Add-On").first()).toBeVisible();
  });

  test("decimal quantity shows validation error", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/command-center");

    await page.locator("#cc-quantity").fill("42.5");
    await expect(
      page.getByRole("alert").filter({ hasText: "whole number" })
    ).toBeVisible();
  });

  test(">5000 shows manager review badge (client-side)", async ({
    page,
  }) => {
    await page.goto("/concepts/command-center");

    // First get a valid quote so page is interactive
    await page.locator("#cc-product-select").selectOption("ST400");
    await waitForHeadlinePrice(page);

    // Set quantity to 5001 - client-side badge should appear
    await page.locator("#cc-quantity").fill("5001");

    // The "Needs manager review" badge is rendered client-side by isHighVolume()
    await expect(
      page.getByText(/manager review/i).first()
    ).toBeVisible({ timeout: 5000 });
  });

  test("extra labor changes flat-fee COGS/price/margin in audit panel", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/command-center");

    // Enable manager mode
    await page.getByRole("switch", { name: "Toggle Manager mode" }).click();

    // Select product and service
    await page.locator("#cc-product-select").selectOption("ST400");
    await page.locator("#cc-service-select").selectOption("Sleeve Print");
    await page.waitForTimeout(500);
    await waitForHeadlinePrice(page);

    // Wait for flat-fee audit data
    await expect(page.getByText("Engine COGS").first()).toBeVisible({
      timeout: 10000,
    });

    const cogs1 = await page
      .getByText("Engine COGS")
      .first()
      .locator("..")
      .textContent();

    // Add extra operator labor
    await page.locator("#cc-extra-op-min").fill("2");
    await page.waitForTimeout(500);

    await expect(page.getByText("Engine COGS").first()).toBeVisible({
      timeout: 10000,
    });

    const cogs2 = await page
      .getByText("Engine COGS")
      .first()
      .locator("..")
      .textContent();

    expect(cogs2).not.toEqual(cogs1);
  });
});
