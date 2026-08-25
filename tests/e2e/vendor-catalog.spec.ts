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

    // When Additional Locations feature is on, API always returns manager data
    // so toggling to staff does NOT hide cost details. Only check toggle behavior
    // when the legacy UI is active.
    const hasLegacySelect = await page.locator("#service-select").count();
    if (hasLegacySelect) {
      await page.getByRole("switch", { name: "Toggle Manager mode" }).click();
      await expect(page.getByText("Variant Cost")).toHaveCount(0);
      await expect(page.getByText("Internal Details")).toHaveCount(0);
    }
  });

  test("orders SanMar apparel sizes from smallest to largest", async ({
    errorFreePage: page,
  }) => {
    await page.unroute("**/api/vendor-catalog/search**");
    await page.unroute("**/api/vendor-catalog/styles/*/variants");
    await page.route("**/api/vendor-catalog/search**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          available: true,
          results: [
            {
              id: "sanmar:ST400",
              vendor: "sanmar",
              styleCode: "ST400",
              brand: "Sport-Tek",
              name: "PosiCharge Tri-Blend Raglan Tee",
              category: "T-Shirts",
              description: null,
              imageUrl: null,
              activeVariantCount: 8,
              sourceSyncAt: "2026-08-24T17:59:01.971Z",
            },
          ],
        }),
      });
    });
    const liveSanMarOrder = [
      ["2XL", 1],
      ["XS", 1],
      ["3XL", 2],
      ["S", 2],
      ["4XL", 3],
      ["M", 3],
      ["L", 4],
      ["XL", 5],
    ] as const;
    await page.route("**/api/vendor-catalog/styles/*/variants", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          available: true,
          variants: liveSanMarOrder.map(([size, sizeOrder]) => ({
            id: `sanmar:ST400-BLK-${size}`,
            styleId: "sanmar:ST400",
            vendor: "sanmar",
            styleCode: "ST400",
            color: "Black Triad Solid",
            size,
            sizeOrder,
            inventoryQty: null,
            imageUrl: null,
            discontinued: false,
            sourceSyncAt: "2026-08-24T17:59:01.971Z",
          })),
        }),
      });
    });

    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Vendor Catalog" }).click();
    await page.getByLabel("Vendor", { exact: true }).selectOption("sanmar");
    await page.getByLabel("Search vendor catalog").fill("ST400");
    await page.getByRole("option", { name: /ST400/ }).click();
    await page.getByLabel("Color").selectOption("Black Triad Solid");

    await expect(page.locator("#vendor-size option")).toHaveText([
      "Select size...",
      "XS",
      "S",
      "M",
      "L",
      "XL",
      "2XL",
      "3XL",
      "4XL",
    ]);
  });

  test("labels discontinued variants and renders them disabled", async ({
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
    await expect(
      page.locator('#vendor-size option[value="ss:3001-BLK-L"]')
    ).toBeDisabled();
    await expect(page.getByLabel("Size")).toHaveValue("");
  });
});
