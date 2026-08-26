import { test, expect } from "./fixtures";

test.describe("Guided Builder", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/concepts/guided-builder");
  });

  test("completes all four steps and produces a quote", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/guided-builder");

    // Step 1: Product - should start on product step
    await expect(page.getByRole("heading", { name: "Product" })).toBeVisible();

    // Select a product from catalog
    await page.locator("#gb-product-select").selectOption("ST400");

    // Click Next
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Step 2: Quantity
    await expect(page.getByRole("heading", { name: "Quantity" })).toBeVisible();
    await page.locator("#gb-quantity").fill("84");
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Step 3: Decoration
    await expect(
      page.getByRole("heading", { name: "Decoration" })
    ).toBeVisible();
    await expect(page.getByText("DTF")).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Step 4: Review - should show quote
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();

    // Wait for the quote to load
    await expect(
      page.locator("[aria-label^='Per-item price']").first()
    ).toBeVisible({ timeout: 10000 });

    // Verify price breakdown is present
    await expect(page.getByText("Product Sell").first()).toBeVisible();
    await expect(page.getByText("Decoration Sell").first()).toBeVisible();
    await expect(page.getByText("Sales Price").first()).toBeVisible();

    // Order total should be visible
    await expect(
      page.locator("[aria-label^='Order total']").first()
    ).toBeVisible();
  });

  test("back navigation preserves values", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/guided-builder");

    // Step 1: Select product
    await page.locator("#gb-product-select").selectOption("PC90H");
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Step 2: Set quantity
    await page.locator("#gb-quantity").fill("200");
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Step 3: Decoration - add a service
    await page.locator("#gb-service-select").selectOption("Sleeve Print");

    // Go back to quantity
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("heading", { name: "Quantity" })).toBeVisible();
    await expect(page.locator("#gb-quantity")).toHaveValue("200");

    // Go back to product
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("heading", { name: "Product" })).toBeVisible();
    await expect(page.locator("#gb-product-select")).toHaveValue("PC90H");

    // Go forward again - values should still be preserved
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator("#gb-quantity")).toHaveValue("200");

    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator("#gb-service-select")).toHaveValue("Sleeve Print");
  });

  test("produces a quote with add-on service", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/guided-builder");

    // Step 1: Product
    await page.locator("#gb-product-select").selectOption("3001");
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Step 2: Quantity
    await page.locator("#gb-quantity").fill("100");
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Step 3: Decoration - add flat-fee service
    await page.locator("#gb-service-select").selectOption("Name + Number");
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Step 4: Review
    await expect(
      page.locator("[aria-label^='Per-item price']").first()
    ).toBeVisible({ timeout: 10000 });

    // Should show add-on section
    await expect(page.getByText("Add-On:").first()).toBeVisible();
    await expect(page.getByText("Items + Add-On").first()).toBeVisible();
  });

  test("decimal quantity shows validation and blocks Next", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/guided-builder");

    // Step 1: Select product
    await page.locator("#gb-product-select").selectOption("ST400");
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Step 2: Enter decimal quantity
    await page.locator("#gb-quantity").fill("50.5");
    await expect(
      page.getByRole("alert").filter({ hasText: "whole number" })
    ).toBeVisible();

    // Next button should be disabled
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  });

  test(">5000 shows manager review warning", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/guided-builder");

    // Step 1: Select product
    await page.locator("#gb-product-select").selectOption("ST400");
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Step 2: Enter high quantity
    await page.locator("#gb-quantity").fill("5001");
    await expect(page.getByText(/manager review/i).first()).toBeVisible();
  });
});
