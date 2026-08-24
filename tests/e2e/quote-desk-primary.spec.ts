import { test, expect } from "./fixtures";

test.describe("Quote Desk Primary (root route)", () => {
  test("root renders Quote Desk directly", async ({ errorFreePage: page }) => {
    await page.goto("/");
    await expect(page.locator("header h1")).toContainText("QUOTE DESK");
  });

  test("root defaults to Vendor Catalog mode", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/");

    // Vendor Catalog button should be active/pressed
    const vendorBtn = page.getByRole("button", { name: "Vendor Catalog" });
    await expect(vendorBtn).toHaveAttribute("aria-pressed", "true");

    // CMP Catalog should NOT be active
    const catalogBtn = page.getByRole("button", { name: "CMP Catalog" });
    await expect(catalogBtn).toHaveAttribute("aria-pressed", "false");
  });

  test("root does not show Manager toggle", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/");

    // The Staff/Manager toggle must not be visible on the primary route
    await expect(
      page.getByRole("switch", { name: "Toggle Manager mode" })
    ).toHaveCount(0);

    // "Local evaluation only" warning must not be present
    await expect(page.getByText("Local evaluation only")).toHaveCount(0);

    // "View mode" label must not be present
    await expect(page.getByText("View mode:")).toHaveCount(0);
  });

  test("legacy /concepts/quote-desk retains evaluation toggle", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");

    // The Staff/Manager toggle must be visible on evaluation route
    await expect(
      page.getByRole("switch", { name: "Toggle Manager mode" })
    ).toBeVisible();
  });

  test("legacy/manual fallback modes are reachable from root", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/");

    // CMP Catalog fallback
    const catalogBtn = page.getByRole("button", { name: "CMP Catalog" });
    await expect(catalogBtn).toBeVisible();
    await catalogBtn.click();
    await expect(catalogBtn).toHaveAttribute("aria-pressed", "true");

    // Manual Cost fallback
    const manualBtn = page.getByRole("button", { name: "Manual Cost" });
    await expect(manualBtn).toBeVisible();
    await manualBtn.click();
    await expect(manualBtn).toHaveAttribute("aria-pressed", "true");
  });

  test("root vendor selection and quoting works", async ({
    errorFreePage: page,
  }) => {
    // Mock vendor search API
    await page.route("**/api/vendor-catalog/search**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          available: true,
          results: [
            {
              id: "ss:3001",
              vendor: "ss",
              styleCode: "3001",
              brand: "BELLA+CANVAS",
              name: "Jersey Tee",
              category: "T-Shirts",
              description: "Soft tee",
              imageUrl: "https://example.test/3001.jpg",
              activeVariantCount: 2,
              sourceSyncAt: "2025-09-09T00:00:00.000Z",
            },
          ],
        }),
      });
    });

    await page.route("**/api/vendor-catalog/styles/*/variants", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          available: true,
          variants: [
            {
              id: "ss:3001-BLK-M",
              styleId: "ss:3001",
              vendor: "ss",
              styleCode: "3001",
              color: "Black",
              size: "M",
              sizeOrder: 30,
              inventoryQty: 42,
              imageUrl: "https://example.test/3001-black.jpg",
              discontinued: false,
              sourceSyncAt: "2025-09-09T00:00:00.000Z",
            },
          ],
        }),
      });
    });

    await page.route("**/api/quote/item", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          productSell: 8.5,
          decorationSell: 4,
          salesPrice: 12.5,
          salesOrderTotal: 1050,
          tierLabel: "84-143",
          requiresManagerReview: false,
        }),
      });
    });

    await page.goto("/");

    // Vendor catalog is the default mode, so search directly
    await page.getByLabel("Search vendor catalog").fill("3001");
    await expect(page.getByRole("option", { name: /3001/ })).toBeVisible();
    await page.getByRole("option", { name: /3001/ }).click();
    await page.getByLabel("Color").selectOption("Black");
    await page.getByLabel("Size").selectOption("M");

    // Quote result should be visible
    await expect(page.locator("[aria-label^='Per-item price']")).toContainText(
      "$12.50"
    );
  });

  test("root route mobile has no horizontal overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const bodyScrollWidth = await page.evaluate(
      () => document.body.scrollWidth
    );
    const windowInnerWidth = await page.evaluate(() => window.innerWidth);

    expect(
      bodyScrollWidth,
      `Body scroll width (${bodyScrollWidth}) should not exceed viewport width (${windowInnerWidth})`
    ).toBeLessThanOrEqual(windowInnerWidth + 1);
  });
});
