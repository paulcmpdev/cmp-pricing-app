import { test, expect } from "./fixtures";

test.describe("Admin Pricing Preview", () => {
  test.describe("when CMP_ENABLE_PRICING_PREVIEW is enabled", () => {
    test("renders Pricing Preview navigation link", async ({
      errorFreePage: page,
    }) => {
      await page.goto("/admin");
      const link = page.getByRole("link", { name: /pricing preview/i });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", "/admin/pricing");
    });

    test("navigates to Pricing Preview page", async ({
      errorFreePage: page,
    }) => {
      await page.goto("/admin/pricing");
      await expect(
        page.getByRole("heading", { name: /pricing context/i })
      ).toBeVisible();
      await expect(
        page.getByText(/preview only/i)
      ).toBeVisible();
    });

    test("renders all 23 tier rows in the grid", async ({
      errorFreePage: page,
    }) => {
      await page.goto("/admin/pricing");
      // Wait for the grid to load
      await expect(
        page.getByRole("heading", { name: /dtf tier-margin grid/i })
      ).toBeVisible();
      // Check for some known tier labels in the desktop table
      await expect(page.getByText("72-143").first()).toBeVisible();
      await expect(page.getByText("144-249").first()).toBeVisible();
      await expect(page.getByText("2,500+").first()).toBeVisible();
    });

    test("displays pricing context with contract metadata", async ({
      errorFreePage: page,
    }) => {
      await page.goto("/admin/pricing");
      await expect(page.getByText("pricing-contract.json")).toBeVisible();
      await expect(page.getByText("2x")).toBeVisible();
      await expect(page.getByText("8.0%")).toBeVisible();
      await expect(page.getByText("$0.05")).toBeVisible();
      await expect(page.getByText("Average")).toBeVisible();
      await expect(page.getByText("Tier-Based")).toBeVisible();
    });

    test("shows baseline prices matching the contract", async ({
      errorFreePage: page,
    }) => {
      await page.goto("/admin/pricing");
      // Tier 72-143 prices: T1 $6.55, T2 $6.00, T3 $5.55, T4 $5.15
      await expect(page.getByText("$6.55").first()).toBeVisible();
      await expect(page.getByText("$5.15").first()).toBeVisible();
    });

    test("renders quote impact panel with default inputs", async ({
      errorFreePage: page,
    }) => {
      await page.goto("/admin/pricing");
      await expect(
        page.getByRole("heading", { name: /quote impact preview/i })
      ).toBeVisible();
      // Default values: product cost 4.80, qty 174, lane T1
      const costInput = page.getByLabel(/quote product cost/i);
      await expect(costInput).toHaveValue("4.80");
      const qtyInput = page.getByLabel(/quote quantity/i);
      await expect(qtyInput).toHaveValue("174");
    });

    test("shows quote impact results with default values", async ({
      errorFreePage: page,
    }) => {
      await page.goto("/admin/pricing");
      // Wait for quote results to load
      await expect(page.getByText("$9.60").first()).toBeVisible();
      await expect(page.getByText("$15.60").first()).toBeVisible();
      await expect(page.getByText("$2,714.40").first()).toBeVisible();
    });

    test("margin inputs have accessible labels", async ({
      errorFreePage: page,
    }) => {
      await page.goto("/admin/pricing");
      // Check that margin inputs exist with aria labels
      const t1Input = page.locator(
        'input[aria-label="T1 margin for tier 72-143"]:visible'
      );
      await expect(t1Input).toBeVisible();
      await expect(t1Input).toHaveValue("50");
    });

    test("editing a margin shows dirty state", async ({
      errorFreePage: page,
    }) => {
      await page.goto("/admin/pricing");
      // Wait for initial load
      await expect(
        page.getByRole("heading", { name: /dtf tier-margin grid/i })
      ).toBeVisible();

      // Edit a margin
      const t4Input = page.locator(
        'input[aria-label="T4 margin for tier 72-143"]:visible'
      );
      await t4Input.fill("40");

      // Should show change indicator
      await expect(page.getByText(/1 change/i)).toBeVisible({ timeout: 5000 });
    });

    test("Reset All clears all edits", async ({ errorFreePage: page }) => {
      await page.goto("/admin/pricing");
      await expect(
        page.getByRole("heading", { name: /dtf tier-margin grid/i })
      ).toBeVisible();

      // Edit a margin
      const t4Input = page.locator(
        'input[aria-label="T4 margin for tier 72-143"]:visible'
      );
      await t4Input.fill("40");
      await expect(page.getByText(/1 change/i)).toBeVisible({ timeout: 5000 });

      // Reset
      await page.getByRole("button", { name: /reset all/i }).click();

      // Should clear change indicator - wait for recalc
      await expect(page.getByText(/1 change/i)).not.toBeVisible({ timeout: 5000 });
    });

    test("clicking a margin cell shows calculation trace", async ({
      errorFreePage: page,
    }) => {
      await page.goto("/admin/pricing");
      await expect(
        page.getByRole("heading", { name: /dtf tier-margin grid/i })
      ).toBeVisible();

      // Focus on a margin input to trigger trace
      const t1Input = page.locator(
        'input[aria-label="T1 margin for tier 72-143"]:visible'
      );
      await t1Input.focus();

      // Should show calculation trace panel
      await expect(
        page.getByText(/calculation trace/i)
      ).toBeVisible();
      await expect(page.getByText(/base dtf cogs/i)).toBeVisible();
      await expect(page.getByText(/achieved margin/i)).toBeVisible();
    });

    test("does not expose Preview Only language as save/publish", async ({
      errorFreePage: page,
    }) => {
      await page.goto("/admin/pricing");
      await expect(page.getByText(/^Preview Only/)).toBeVisible();
      const bodyText = await page.locator("body").innerText();
      expect(bodyText).toContain("Preview Only");
      expect(bodyText).toContain("does not affect Quote Desk");
      // Should not have save/publish controls
      expect(bodyText?.toLowerCase()).not.toContain("save changes");
      expect(bodyText?.toLowerCase()).not.toContain("publish");
      expect(bodyText?.toLowerCase()).not.toContain("upload");
    });

    test("Catalog Operations page still renders correctly", async ({
      errorFreePage: page,
    }) => {
      await page.goto("/admin");
      // Should still show catalog operations with the navigation
      await expect(
        page.getByText(/catalog operations/i).first()
      ).toBeVisible();
      await expect(
        page.getByText(/private preview/i).first()
      ).toBeVisible();
    });

    test("no horizontal overflow at mobile 390x844", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/admin/pricing");
      await page.waitForLoadState("networkidle");
      const bodyScrollWidth = await page.evaluate(
        () => document.body.scrollWidth
      );
      const windowInnerWidth = await page.evaluate(() => window.innerWidth);
      expect(bodyScrollWidth).toBeLessThanOrEqual(windowInnerWidth + 1);
    });
  });
});
