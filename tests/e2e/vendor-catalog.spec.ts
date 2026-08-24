import { test, expect } from "./fixtures";

test.describe("Quote Desk vendor catalog mode", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/vendor-catalog/search**", async (route) => {
      const url = new URL(route.request().url());
      const q = url.searchParams.get("q") ?? "";
      if (q === "zz") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ available: true, results: [] }),
        });
        return;
      }
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
            {
              id: "ss:3001-BLK-L",
              styleId: "ss:3001",
              vendor: "ss",
              styleCode: "3001",
              color: "Black",
              size: "L",
              sizeOrder: 40,
              inventoryQty: 0,
              imageUrl: "https://example.test/3001-black.jpg",
              discontinued: true,
              sourceSyncAt: "2025-09-09T00:00:00.000Z",
            },
          ],
        }),
      });
    });
  });

  test("selects a vendor variant and quotes without exposing Staff cost", async ({
    errorFreePage: page,
  }) => {
    let quoteBody: unknown;
    await page.route("**/api/quote/item", async (route) => {
      quoteBody = route.request().postDataJSON();
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

    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Vendor Catalog" }).click();
    await page.getByLabel("Vendor", { exact: true }).selectOption("ss");
    await page.getByLabel("Search vendor catalog").fill("3001");

    await expect(page.getByRole("option", { name: /3001/ })).toBeVisible();
    await page.getByRole("option", { name: /3001/ }).click();
    await page.getByLabel("Color").selectOption("Black");
    await page.getByLabel("Size").selectOption("M");

    await expect(page.getByText("Inventory: 42")).toBeVisible();
    await expect(page.getByText("Snapshot is stale")).toBeVisible();
    await expect(page.locator("[aria-label^='Per-item price']")).toContainText("$12.50");
    expect(quoteBody).toMatchObject({
      catalogVariantId: "ss:3001-BLK-M",
      quantity: 84,
    });
    await expect(page.getByText("Internal Details", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Variant Cost", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Cost Basis", { exact: true })).toHaveCount(0);
  });

  test("shows vendor catalog empty state", async ({ errorFreePage: page }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Vendor Catalog" }).click();
    await page.getByLabel("Search vendor catalog").fill("zz");

    await expect(page.getByText("No vendor styles found.")).toBeVisible();
  });

  test("clears a prior vendor item quote when vendor search changes", async ({
    errorFreePage: page,
  }) => {
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

    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Vendor Catalog" }).click();
    await page.getByLabel("Search vendor catalog").fill("3001");
    await page.getByRole("option", { name: /3001/ }).click();
    await page.getByLabel("Color").selectOption("Black");
    await page.getByLabel("Size").selectOption("M");
    await expect(page.locator("[aria-label^='Per-item price']")).toContainText("$12.50");

    await page.getByLabel("Search vendor catalog").fill("3001C");
    await expect(page.locator("[aria-label^='Per-item price']")).toHaveCount(0);
    await expect(
      page.getByText("Select a product and quantity to see pricing.")
    ).toBeVisible();
  });

  test("clears manager cost details immediately when switching back to Staff", async ({
    errorFreePage: page,
  }) => {
    await page.route("**/api/quote/item", async (route) => {
      const role = route.request().headers()["x-cmp-role"];
      const staff = {
        productSell: 8.5,
        decorationSell: 4,
        salesPrice: 12.5,
        salesOrderTotal: 1050,
        tierLabel: "84-143",
        requiresManagerReview: false,
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          role === "manager"
            ? {
                ...staff,
                commissionReserve: 1,
                totalDecorationCogs: 2,
                totalProductionCogs: 6,
                grossProfitBeforeCommission: 6.5,
                netContributionAfterCommission: 5.5,
                combinedGrossMarginBeforeCommission: 0.52,
                contributionMarginAfterCommission: 0.44,
                productionCogsOrderTotal: 504,
                netContributionOrderTotal: 462,
                vendorCatalog: {
                  vendor: "ss",
                  variantId: "ss:3001-BLK-M",
                  styleId: "ss:3001",
                  styleCode: "3001",
                  color: "Black",
                  size: "M",
                  unitCost: 5.00,
                  costBasis: "piecePrice",
                  sourceSyncAt: "2025-09-09T00:00:00.000Z",
                },
              }
            : staff
        ),
      });
    });

    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Vendor Catalog" }).click();
    await page.getByLabel("Search vendor catalog").fill("3001");
    await page.getByRole("option", { name: /3001/ }).click();
    await page.getByLabel("Color").selectOption("Black");
    await page.getByRole("switch", { name: "Toggle Manager mode" }).click();
    await page.getByLabel("Size").selectOption("M");

    await expect(page.getByText("Variant Cost")).toBeVisible();
    await page.getByRole("switch", { name: "Toggle Manager mode" }).click();
    await expect(page.getByText("Variant Cost")).toHaveCount(0);
    await expect(page.getByText("Internal Details")).toHaveCount(0);
  });

  test("labels discontinued variants and warns when selected", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Vendor Catalog" }).click();
    await page.getByLabel("Search vendor catalog").fill("3001");
    await page.getByRole("option", { name: /3001/ }).click();
    await page.getByLabel("Color").selectOption("Black");

    await expect(
      page.locator('#vendor-size option[value="ss:3001-BLK-L"]')
    ).toHaveText("L - discontinued");
    await page.getByLabel("Size").selectOption("ss:3001-BLK-L");
    await expect(
      page.getByText("Selected vendor variant is discontinued. Confirm availability before quoting.")
    ).toBeVisible();
  });
});
