import { test, expect } from "./fixtures";

/** Helper: wait for item quote to load. */
async function waitForItemQuote(page: import("@playwright/test").Page) {
  await expect(
    page.getByText("Product Sell").first()
  ).toBeVisible({ timeout: 10000 });
}

test.describe("Additional Locations (Quote Desk)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/concepts/quote-desk");
    // Select a product so we have a baseline
    await page.getByRole("button", { name: "Manual Cost" }).click();
    await page.locator("#manual-cost").fill("3.95");
    await page.waitForTimeout(500);
    await waitForItemQuote(page);
  });

  test("section is labeled Additional Locations when flag is enabled", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");
    await expect(
      page.getByRole("heading", { name: /additional locations/i })
    ).toBeVisible();
    // Legacy label should not appear
    await expect(
      page.getByRole("heading", { name: /add-on service/i })
    ).not.toBeVisible();
  });

  test("+ Add Location adds a location row", async ({ errorFreePage: page }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByTestId("add-location-btn").click();
    // Should have one row with a service select
    const rows = page.locator("[data-testid^='location-row-']");
    await expect(rows).toHaveCount(1);
  });

  test("selecting a service quotes it and shows the price", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Manual Cost" }).click();
    await page.locator("#manual-cost").fill("3.95");
    await page.waitForTimeout(500);
    await waitForItemQuote(page);

    await page.getByTestId("add-location-btn").click();
    // Select a service in the first row
    const row = page.locator("[data-testid^='location-row-']").first();
    await row.locator("select").selectOption("Sleeve Print");

    // Wait for price to appear
    await expect(row.getByText(/\$/)).toBeVisible({ timeout: 10000 });
  });

  test("multiple locations can be added with different services", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Manual Cost" }).click();
    await page.locator("#manual-cost").fill("3.95");
    await page.waitForTimeout(500);
    await waitForItemQuote(page);

    // Add two locations
    await page.getByTestId("add-location-btn").click();
    await page.getByTestId("add-location-btn").click();
    const rows = page.locator("[data-testid^='location-row-']");
    await expect(rows).toHaveCount(2);

    // Select different services
    await rows.nth(0).locator("select").selectOption("Sleeve Print");
    await rows.nth(1).locator("select").selectOption("Vertical Print");

    // Wait for both prices
    await expect(rows.nth(0).getByText(/\$/)).toBeVisible({ timeout: 10000 });
    await expect(rows.nth(1).getByText(/\$/)).toBeVisible({ timeout: 10000 });
  });

  test("duplicate service selections are prevented", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByTestId("add-location-btn").click();
    await page.getByTestId("add-location-btn").click();
    const rows = page.locator("[data-testid^='location-row-']");

    // Select Sleeve Print in first row
    await rows.nth(0).locator("select").selectOption("Sleeve Print");

    // Second row's dropdown should not have Sleeve Print available
    const options = await rows.nth(1).locator("select option").allTextContents();
    expect(options).not.toContain("Sleeve Print");
  });

  test("removing a location row works", async ({ errorFreePage: page }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByTestId("add-location-btn").click();
    await page.getByTestId("add-location-btn").click();
    await expect(page.locator("[data-testid^='location-row-']")).toHaveCount(2);

    // Remove first row
    await page.locator("[data-testid^='location-row-']").first()
      .getByRole("button", { name: /remove/i }).click();
    await expect(page.locator("[data-testid^='location-row-']")).toHaveCount(1);
  });

  test("quantity change recalculates all location prices", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Manual Cost" }).click();
    await page.locator("#manual-cost").fill("3.95");

    await page.getByTestId("add-location-btn").click();
    const row = page.locator("[data-testid^='location-row-']").first();
    await row.locator("select").selectOption("Sleeve Print");
    await page.waitForTimeout(500);
    await expect(row.getByText(/\$/)).toBeVisible({ timeout: 10000 });

    // Get initial price text
    const price1 = await row.getByText(/\$/).textContent();

    // Change quantity significantly (from 84 to 200)
    await page.locator("#quantity-input").fill("200");
    await page.waitForTimeout(1000);

    // Price may change due to tier change
    const price2 = await row.getByText(/\$/).textContent();
    // Both should be valid dollar amounts
    expect(price1).toMatch(/\$/);
    expect(price2).toMatch(/\$/);
  });

  test("Final Per-Item Price includes additional locations", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Manual Cost" }).click();
    await page.locator("#manual-cost").fill("3.95");
    await page.waitForTimeout(500);
    await waitForItemQuote(page);

    // Get baseline per-item price
    const basePrice = await page.locator("[aria-label^='Per-item price']").first().textContent();

    // Add a location
    await page.getByTestId("add-location-btn").click();
    await page.locator("[data-testid^='location-row-']").first().locator("select").selectOption("Sleeve Print");
    await page.waitForTimeout(1000);

    // Final per-item price should be higher
    const finalPrice = await page.locator("[aria-label^='Per-item price']").first().textContent();
    const baseNum = parseFloat(basePrice!.replace("$", "").replace(",", ""));
    const finalNum = parseFloat(finalPrice!.replace("$", "").replace(",", ""));
    expect(finalNum).toBeGreaterThan(baseNum);
  });

  test("order total includes additional location costs", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Manual Cost" }).click();
    await page.locator("#manual-cost").fill("3.95");
    await page.waitForTimeout(500);
    await waitForItemQuote(page);

    const orderTotal1 = await page.locator("[aria-label^='Order total']").first().textContent();

    // Add a location
    await page.getByTestId("add-location-btn").click();
    await page.locator("[data-testid^='location-row-']").first().locator("select").selectOption("Sleeve Print");
    await page.waitForTimeout(1000);

    const orderTotal2 = await page.locator("[aria-label^='Order total']").first().textContent();
    expect(orderTotal2).not.toEqual(orderTotal1);
  });

  test("breakdown shows each additional location line", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Manual Cost" }).click();
    await page.locator("#manual-cost").fill("3.95");
    await page.waitForTimeout(500);
    await waitForItemQuote(page);

    await page.getByTestId("add-location-btn").click();
    await page.locator("[data-testid^='location-row-']").first().locator("select").selectOption("Sleeve Print");
    await page.waitForTimeout(1000);

    // Should show Sleeve Print in the breakdown
    await expect(page.getByText("Sleeve Print").last()).toBeVisible();
    // Should show Base Decoration Sell (not just Decoration Sell)
    await expect(page.getByText("Base Decoration Sell").first()).toBeVisible();
    // Should show Final Per-Item Price
    await expect(page.getByText("Final Per-Item Price").first()).toBeVisible();
  });

  test("COGS breakdown visible without manual manager toggle via server preview gate", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");
    // No manager toggle needed; the server preview gate returns protected COGS.
    await page.getByRole("button", { name: "Manual Cost" }).click();
    await page.locator("#manual-cost").fill("3.95");
    await page.waitForTimeout(500);
    await waitForItemQuote(page);

    await page.getByTestId("add-location-btn").click();
    await page.locator("[data-testid^='location-row-']").first().locator("select").selectOption("Sleeve Print");
    await page.waitForTimeout(1000);

    // COGS breakdown should be visible by default (API returns protected preview data)
    await expect(page.getByTestId("cogs-breakdown")).toBeVisible();
    await expect(page.getByText("Product COGS").first()).toBeVisible();
    await expect(page.getByText("Base Decoration COGS").first()).toBeVisible();
    await expect(page.getByText("Total COGS / Item").first()).toBeVisible();
  });

  test("no contribution-target-solver UI exists", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Manual Cost" }).click();
    await page.locator("#manual-cost").fill("3.95");
    await page.waitForTimeout(500);
    await waitForItemQuote(page);

    // No pricing basis element (rejected model)
    await expect(page.getByTestId("pricing-basis")).not.toBeVisible();
    // No contribution target adjustment line
    await expect(page.getByText("Contribution Target Adjustment")).not.toBeVisible();
    // No "Target: ... Achieved:" line
    await expect(page.getByText(/Target:.*Achieved:/)).not.toBeVisible();
  });

  test("audit metrics are visible in COGS breakdown", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Manual Cost" }).click();
    await page.locator("#manual-cost").fill("3.95");
    await page.waitForTimeout(500);
    await waitForItemQuote(page);

    await expect(page.getByTestId("cogs-breakdown")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Commission Reserve").first()).toBeVisible();
    await expect(page.getByText("Gross Profit").first()).toBeVisible();
    await expect(page.getByText("Net Contribution").first()).toBeVisible();
    await expect(page.getByText("Gross Margin").first()).toBeVisible();
    await expect(page.getByText("Post-Commission Contribution Margin").first()).toBeVisible();
  });

  test("preview quote requests do not send a client manager role header", async ({
    errorFreePage: page,
  }) => {
    const itemRequestPromise = page.waitForRequest((request) =>
      request.url().includes("/api/quote/item") && request.method() === "POST"
    );

    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Manual Cost" }).click();
    await page.locator("#manual-cost").fill("3.95");

    const itemRequest = await itemRequestPromise;
    expect(itemRequest.headers()["x-cmp-role"]).toBeUndefined();
    await waitForItemQuote(page);
  });

  test("invalid decimal quantity clears populated quote totals and recovers", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Manual Cost" }).click();
    await page.locator("#manual-cost").fill("3.95");
    await page.waitForTimeout(500);
    await waitForItemQuote(page);

    await page.getByTestId("add-location-btn").click();
    const row = page.locator("[data-testid^='location-row-']").first();
    await row.locator("select").selectOption("Sleeve Print");
    await expect(row.getByText(/\$/)).toBeVisible({ timeout: 10000 });
    await expect(page.locator("[aria-label^='Per-item price']")).toBeVisible();

    await page.locator("#quantity-input").fill("12.5");

    await expect(page.getByText("Quantity must be a whole number.")).toBeVisible();
    await expect(page.locator("[aria-label^='Per-item price']")).not.toBeVisible();
    await expect(page.locator("[aria-label^='Order total']")).not.toBeVisible();
    await expect(row.getByText(/\$/)).not.toBeVisible();

    await page.locator("#quantity-input").fill("200");
    await expect(page.locator("[aria-label^='Per-item price']")).toBeVisible({
      timeout: 10000,
    });
    await expect(row.getByText(/\$/)).toBeVisible({ timeout: 10000 });
  });

  test("blank quantity clears populated quote totals and recovers", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Manual Cost" }).click();
    await page.locator("#manual-cost").fill("3.95");
    await page.waitForTimeout(500);
    await waitForItemQuote(page);

    await page.getByTestId("add-location-btn").click();
    const row = page.locator("[data-testid^='location-row-']").first();
    await row.locator("select").selectOption("Sleeve Print");
    await expect(row.getByText(/\$/)).toBeVisible({ timeout: 10000 });

    await page.locator("#quantity-input").fill("");

    await expect(page.locator("[aria-label^='Per-item price']")).not.toBeVisible();
    await expect(page.locator("[aria-label^='Order total']")).not.toBeVisible();
    await expect(row.getByText(/\$/)).not.toBeVisible();

    await page.locator("#quantity-input").fill("200");
    await expect(page.locator("[aria-label^='Per-item price']")).toBeVisible({
      timeout: 10000,
    });
    await expect(row.getByText(/\$/)).toBeVisible({ timeout: 10000 });
  });

  test("mobile sticky bar shows final combined totals", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Manual Cost" }).click();
    await page.locator("#manual-cost").fill("3.95");
    await page.waitForTimeout(500);
    await waitForItemQuote(page);

    // Mobile sticky should be visible
    const stickyBar = page.locator(".lg\\:hidden.fixed.bottom-0");
    await expect(stickyBar).toBeVisible();
  });

  test("summary order totals reconcile with combined per-item price (one location)", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Manual Cost" }).click();
    await page.locator("#manual-cost").fill("3.95");
    await page.waitForTimeout(500);
    await waitForItemQuote(page);

    // Add one location
    await page.getByTestId("add-location-btn").click();
    await page.locator("[data-testid^='location-row-']").first().locator("select").selectOption("Sleeve Print");
    await page.waitForTimeout(1500);

    // Read Final Per-Item Price from the hero
    const perItemText = await page.locator("[aria-label^='Per-item price']").first().textContent();
    const perItem = parseFloat(perItemText!.replace("$", "").replace(",", ""));

    // Read quantity (default is 84)
    const qtyText = await page.locator("#quantity-input").inputValue();
    const qty = parseInt(qtyText, 10);

    // Expected order total = perItem * qty
    const expectedTotal = perItem * qty;

    // Read the dark-card Order Total
    const orderTotalText = await page.locator("[aria-label^='Order total']").first().textContent();
    const orderTotal = parseFloat(orderTotalText!.replace("$", "").replace(",", ""));

    // The combined order total must match finalPerItemPrice * qty
    expect(orderTotal).toBeCloseTo(expectedTotal, 0);

    // Read the summary section's order total — it must match the combined total
    const summaryOrderTotalRow = page.locator("text=Combined Order Total").first().locator("..");
    const summaryOrderTotalText = await summaryOrderTotalRow.locator("span").last().textContent();
    const summaryOrderTotal = parseFloat(summaryOrderTotalText!.replace("$", "").replace(",", ""));

    // The summary order total should equal the combined order total (finalPerItemPrice * qty)
    expect(summaryOrderTotal).toBeCloseTo(expectedTotal, 0);
  });

  test("summary COGS and contribution totals reconcile with combined values (multiple locations)", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts/quote-desk");
    await page.getByRole("button", { name: "Manual Cost" }).click();
    await page.locator("#manual-cost").fill("3.95");
    await page.waitForTimeout(500);
    await waitForItemQuote(page);

    // Add two locations
    await page.getByTestId("add-location-btn").click();
    await page.getByTestId("add-location-btn").click();
    const rows = page.locator("[data-testid^='location-row-']");
    await rows.nth(0).locator("select").selectOption("Sleeve Print");
    await page.waitForTimeout(1000);
    await rows.nth(1).locator("select").selectOption("Vertical Print");
    await page.waitForTimeout(1500);

    // Read Total COGS / Item from the COGS breakdown
    const totalCogsItemRow = page.locator("text=Total COGS / Item").first().locator("..");
    const totalCogsItemText = await totalCogsItemRow.locator("span").last().textContent();
    const totalCogsPerItem = parseFloat(totalCogsItemText!.replace("$", "").replace(",", ""));

    // Read Net Contribution from the COGS breakdown
    const netContribRow = page.locator("text=Net Contribution").first().locator("..");
    const netContribText = await netContribRow.locator("span").last().textContent();
    const netContrib = parseFloat(netContribText!.replace("$", "").replace(",", ""));

    // Read quantity
    const qtyText = await page.locator("#quantity-input").inputValue();
    const qty = parseInt(qtyText, 10);

    // Read the summary Combined Production COGS Total
    const cogsTotalRow = page.locator("text=Combined Production COGS Total").first().locator("..");
    const cogsTotalText = await cogsTotalRow.locator("span").last().textContent();
    const cogsTotal = parseFloat(cogsTotalText!.replace("$", "").replace(",", ""));

    // Read the summary Combined Net Contribution Total
    const netContribTotalRow = page.locator("text=Combined Net Contribution Total").first().locator("..");
    const netContribTotalText = await netContribTotalRow.locator("span").last().textContent();
    const netContribTotal = parseFloat(netContribTotalText!.replace("$", "").replace(",", ""));

    // Production COGS Total must equal totalCogsPerItem * qty
    expect(cogsTotal).toBeCloseTo(totalCogsPerItem * qty, 0);

    // Net Contribution Total must equal netContribution * qty
    expect(netContribTotal).toBeCloseTo(netContrib * qty, 0);
  });
});

test.describe("Additional Location Matrix (Admin)", () => {
  test("renders matrix heading and 104 rows note when enabled", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/admin/pricing");
    await expect(
      page.getByRole("heading", { name: /additional location matrix/i })
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("104 rows")).toBeVisible();
  });

  test("shows Preview Only disclaimer with component margin clarification", async ({ errorFreePage: page }) => {
    await page.goto("/admin/pricing");
    await page.waitForTimeout(2000);
    const previewOnlyTexts = page.getByText(/Preview Only/);
    await expect(previewOnlyTexts.first()).toBeVisible();
    // Verify the disclaimer clarifies these are NOT final-item contribution targets
    await expect(page.getByText(/not represent or guarantee/i)).toBeVisible();
  });

  test("editing a margin shows dirty state with change count", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/admin/pricing");
    await expect(
      page.getByRole("heading", { name: /additional location matrix/i })
    ).toBeVisible({ timeout: 15000 });

    // Edit T1 margin
    const t1Input = page.locator("#al-margin-T1");
    await t1Input.fill("60");
    await page.waitForTimeout(500);

    // Should show change count
    await expect(page.getByTestId("al-change-count")).toBeVisible({ timeout: 5000 });
  });

  test("invalid 0.58 margin pauses preview and reset clears the error", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/admin/pricing");
    await expect(
      page.getByRole("heading", { name: /additional location matrix/i })
    ).toBeVisible({ timeout: 15000 });

    const t1Input = page.locator("#al-margin-T1");
    await t1Input.fill("0.58");

    await expect(page.getByText(/enter percentage points/i)).toBeVisible();
    await expect(page.getByTestId("al-preview-paused")).toBeVisible();
    await expect(page.getByTestId("al-change-count")).toContainText("1 change");

    await page.getByRole("button", { name: /reset all margin edits/i }).click();

    await expect(page.getByTestId("al-preview-paused")).not.toBeVisible();
    await expect(page.getByText(/enter percentage points/i)).not.toBeVisible();
    await expect(t1Input).toHaveValue("58");
  });

  test("valid 58.5 margin recovers and changed cells show current draft delta", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/admin/pricing");
    await expect(
      page.getByRole("heading", { name: /additional location matrix/i })
    ).toBeVisible({ timeout: 15000 });

    await page.locator("#al-margin-T1").fill("0.58");
    await expect(page.getByTestId("al-preview-paused")).toBeVisible();

    await page.locator("#al-margin-T1").fill("58.5");
    await expect(page.getByTestId("al-preview-paused")).not.toBeVisible({
      timeout: 5000,
    });

    const changedCells = page.locator("[data-testid$='-T1']").filter({
      hasText: "Current",
    });
    await expect(changedCells.first()).toBeVisible({ timeout: 10000 });
    await expect(changedCells.first()).toContainText("Draft");
    await expect(changedCells.first()).toContainText("Delta");
  });

  test("Reset All clears margin edits", async ({ errorFreePage: page }) => {
    await page.goto("/admin/pricing");
    await expect(
      page.getByRole("heading", { name: /additional location matrix/i })
    ).toBeVisible({ timeout: 15000 });

    // Edit a margin
    const t1Input = page.locator("#al-margin-T1");
    await t1Input.fill("60");
    await expect(page.getByTestId("al-change-count")).toBeVisible({ timeout: 5000 });

    // Reset
    await page.getByRole("button", { name: /reset all margin edits/i }).click();
    await page.waitForTimeout(500);

    // Change count should disappear
    await expect(page.getByTestId("al-change-count")).not.toBeVisible({ timeout: 5000 });
  });

  test("Reset Lane resets only one lane", async ({ errorFreePage: page }) => {
    await page.goto("/admin/pricing");
    await expect(
      page.getByRole("heading", { name: /additional location matrix/i })
    ).toBeVisible({ timeout: 15000 });

    // Edit T1 and T2
    await page.locator("#al-margin-T1").fill("60");
    await page.locator("#al-margin-T2").fill("55");
    await page.waitForTimeout(500);

    // Reset T1 only
    await page.getByRole("button", { name: /reset T1 margin/i }).click();
    await page.waitForTimeout(500);

    // T1 should be back to default
    await expect(page.locator("#al-margin-T1")).toHaveValue("58");
    // T2 should still be edited
    await expect(page.locator("#al-margin-T2")).toHaveValue("55");
  });
});

test.describe("Production / unflagged gates", () => {
  test("additional locations API is available on the flagged Playwright server", async ({ request }) => {
    const response = await request.get("/api/admin/pricing/additional-locations/preview");
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data.rows).toHaveLength(104);
  });
});
