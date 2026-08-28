import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const dtfHeading = (page: Page) =>
  page.getByRole("heading", { name: "DTF Pricing Matrix", exact: true });

const dtfSection = (page: Page): Locator =>
  page.locator("section").filter({ has: dtfHeading(page) }).first();

async function openPricing(page: Page) {
  await page.goto("/admin/pricing");
  await expect(dtfHeading(page)).toBeVisible();
}

async function editDtfMatrix(page: Page, quantityLabel = "72-143") {
  await openPricing(page);
  const dtf = dtfSection(page);
  await dtf.getByRole("button", { name: "Edit Matrix" }).click();
  await dtf
    .getByRole("button", { name: `Select quantity ${quantityLabel}`, exact: true })
    .click();
  await expect(
    dtf.getByLabel(`Tier ${quantityLabel} T1 DTF GM percent`, { exact: true })
  ).toBeEditable();
}

test.describe("Admin Pricing Preview", () => {
  test.describe("when CMP_ENABLE_PRICING_PREVIEW is enabled", () => {
    test("renders and follows the Pricing Preview navigation link", async ({
      errorFreePage: page,
    }) => {
      await page.goto("/admin");
      const link = page.getByRole("link", { name: /pricing preview/i });

      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", "/admin/pricing");
      await link.click();
      await expect(page).toHaveURL(/\/admin\/pricing$/);
      await expect(dtfHeading(page)).toBeVisible();
    });

    test("shows one 23-quantity DTF matrix with Additional Prints below it", async ({
      errorFreePage: page,
    }) => {
      await openPricing(page);
      const dtf = dtfSection(page);
      const additionalHeading = page.getByRole("heading", {
        name: "Additional Prints / DTF Flat Fees",
        exact: true,
      });

      const matrixPanel = dtf.getByTestId("dtf-matrix-table-panel");
      const inspector = dtf.getByTestId("dtf-quantity-inspector");
      const quoteHeading = dtf.getByRole("heading", { name: "Quote Impact Preview" });

      await expect(matrixPanel.getByRole("table")).toHaveCount(1);
      await expect(dtf.getByText("23 quantities", { exact: true })).toBeVisible();
      await expect(dtf.getByRole("row")).toHaveCount(24);
      await expect(
        dtf.getByRole("row").filter({ hasText: "72-143" }).first()
      ).toBeVisible();
      await expect(
        dtf.getByRole("row").filter({ hasText: "144-249" }).first()
      ).toBeVisible();
      await expect(
        dtf.getByRole("button", { name: "Select quantity 2500+", exact: true })
      ).toBeVisible();
      await expect(inspector).toBeVisible();
      await expect(inspector.getByRole("heading", { name: "Quantity Inspector" })).toBeVisible();
      await expect(quoteHeading).toBeVisible();
      await expect(inspector.getByRole("heading", { name: "Quote Impact Preview" })).toHaveCount(0);
      await expect(additionalHeading).toBeVisible();

      const quoteFollowsWorkspace = await matrixPanel.evaluate(
        (workspace, quote) =>
          Boolean(workspace.compareDocumentPosition(quote as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
        await quoteHeading.elementHandle()
      );
      expect(quoteFollowsWorkspace).toBe(true);

      const headingOrder = await dtfHeading(page).evaluate(
        (heading, additional) =>
          Boolean(heading.compareDocumentPosition(additional as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
        await additionalHeading.elementHandle()
      );
      expect(headingOrder).toBe(true);
    });

    test("keeps calculation context collapsed behind SHOW and reveals policy values", async ({
      errorFreePage: page,
    }) => {
      await openPricing(page);
      const dtf = dtfSection(page);
      const summary = dtf.locator("summary").filter({ hasText: "Calculation Context" });
      const details = summary.locator("xpath=..");

      await expect(summary).toBeVisible();
      await expect(summary.getByText("show", { exact: true })).toBeVisible();
      await expect(details).not.toHaveAttribute("open", "");
      await expect(dtf.getByText("Product Multiplier", { exact: true })).toBeHidden();

      await summary.click();

      await expect(details).toHaveAttribute("open", "");
      await expect(dtf.getByText("Product Multiplier", { exact: true })).toBeVisible();
      await expect(dtf.getByText("2x", { exact: true })).toBeVisible();
      await expect(dtf.getByText("8.0%", { exact: true })).toBeVisible();
      await expect(dtf.getByText("$0.05", { exact: true })).toBeVisible();
      await expect(dtf.getByText("Average", { exact: true })).toBeVisible();
      await expect(dtf.getByText("Tier-Based", { exact: true })).toBeVisible();
    });

    test("uses accessible Quote Impact defaults", async ({ errorFreePage: page }) => {
      await openPricing(page);
      const dtf = dtfSection(page);

      await expect(dtf.getByRole("heading", { name: "Quote Impact Preview" })).toBeVisible();
      await expect(dtf.getByLabel("Product Cost", { exact: true })).toHaveValue("4.80");
      await expect(dtf.getByLabel("Quantity", { exact: true })).toHaveValue("174");
      await expect(dtf.getByLabel("Pricing Lane", { exact: true })).toHaveValue("T1");
      await expect(dtf.getByTestId("dtf-quote-impact-result")).toBeVisible();
    });

    test("requires Edit Matrix before paired price and DTF GM inputs appear", async ({
      errorFreePage: page,
    }) => {
      await openPricing(page);
      const dtf = dtfSection(page);

      await expect(dtf.getByLabel("Tier 72-143 T1 price", { exact: true })).toHaveCount(0);
      await expect(
        dtf.getByLabel("Tier 72-143 T1 DTF GM percent", { exact: true })
      ).toHaveCount(0);

      await dtf.getByRole("button", { name: "Edit Matrix" }).click();
      await dtf.getByRole("button", { name: "Select quantity 72-143", exact: true }).click();

      await expect(dtf.getByLabel("Tier 72-143 T1 price", { exact: true })).toHaveValue("6.55");
      await expect(
        dtf.getByLabel("Tier 72-143 T1 DTF GM percent", { exact: true })
      ).toBeEditable();
    });

    test("direct price edits recalculate the paired DTF GM%", async ({
      errorFreePage: page,
    }) => {
      await editDtfMatrix(page);
      const dtf = dtfSection(page);
      const price = dtf.getByLabel("Tier 72-143 T1 price", { exact: true });
      const margin = dtf.getByLabel("Tier 72-143 T1 DTF GM percent", { exact: true });
      const priceCell = price.locator("xpath=../../..");
      const startingMargin = await margin.inputValue();

      await price.fill("7.00");

      await expect(price).toHaveValue("7.00");
      await expect(margin).not.toHaveValue(startingMargin);
      await expect(priceCell.getByText("from price", { exact: true })).toBeVisible();
    });

    test("DTF GM% edits recalculate a rounded direct price and Quote Impact", async ({
      errorFreePage: page,
    }) => {
      await editDtfMatrix(page, "144-249");
      const dtf = dtfSection(page);
      const price = dtf.getByLabel("Tier 144-249 T1 price", { exact: true });
      const margin = dtf.getByLabel("Tier 144-249 T1 DTF GM percent", { exact: true });
      const priceCell = margin.locator("xpath=../../..");
      const quoteImpact = dtf.getByTestId("dtf-quote-impact-result");
      const saved = quoteImpact.getByRole("heading", { name: "Saved", exact: true }).locator("..");
      const draft = quoteImpact.getByRole("heading", { name: "Draft", exact: true }).locator("..");
      const savedUnitPrice = saved.getByText("Unit Price", { exact: true }).locator("..");
      const draftUnitPrice = draft.getByText("Unit Price", { exact: true }).locator("..");
      const savedOrder = saved.getByText("Order Total", { exact: true }).locator("..");
      const draftOrder = draft.getByText("Order Total", { exact: true }).locator("..");

      await expect(quoteImpact.getByText(/Tier\s+144-249/)).toBeVisible();
      const savedUnitPriceValue = await savedUnitPrice.locator("dd > span").first().innerText();
      const savedOrderValue = await savedOrder.locator("dd > span").first().innerText();

      await margin.fill("40");

      await expect(price).not.toHaveValue("6.00");
      await expect.poll(async () => Number(await price.inputValue()) * 20).toBeCloseTo(
        Math.round(Number(await price.inputValue()) * 20),
        8
      );
      await expect(priceCell.getByText("from GM%", { exact: true })).toBeVisible();
      await expect(draftUnitPrice.locator("dd > span")).toHaveCount(2);
      await expect(draftOrder.locator("dd > span")).toHaveCount(2);
      await expect(draftUnitPrice.locator("dd > span").first()).not.toHaveText(
        savedUnitPriceValue
      );
      await expect(draftOrder.locator("dd > span").first()).not.toHaveText(savedOrderValue);
      await expect(quoteImpact.getByText(/Order delta:/)).toBeVisible();
    });

    test("keeps an invalid 100% GM invalid and blocks persistence where available", async ({
      errorFreePage: page,
    }) => {
      await editDtfMatrix(page);
      const dtf = dtfSection(page);
      const margin = dtf.getByLabel("Tier 72-143 T1 DTF GM percent", { exact: true });
      const originalPrice = await dtf
        .getByLabel("Tier 72-143 T1 price", { exact: true })
        .inputValue();

      await margin.fill("100");
      await margin.blur();

      await expect(margin).toHaveValue("100");
      await expect(margin).toHaveAttribute("aria-invalid", "true");
      await expect(dtf.getByText(/less than 100%/i)).toBeVisible();
      await expect(dtf.getByTestId("dtf-cell-input-errors")).toContainText("72-143");
      await expect(dtf.getByLabel("Tier 72-143 T1 price", { exact: true })).toHaveValue(
        originalPrice
      );

      const save = dtf.getByRole("button", { name: "Save Changes" });
      if (await save.count()) await expect(save).toBeDisabled();
      else await expect(dtf.getByText("Preview Only", { exact: true })).toBeVisible();
    });

    test("preserves lane labels, Active toggles, Add Lane, and Add Tier controls", async ({
      errorFreePage: page,
    }) => {
      await editDtfMatrix(page);
      const dtf = dtfSection(page);

      await dtf.getByRole("button", { name: "Manage Lanes", exact: true }).click();
      await expect(dtf.getByLabel("Lane T1 label", { exact: true })).toHaveValue("T1");
      await expect(dtf.getByRole("checkbox", { name: "Active" })).toHaveCount(4);
      await expect(dtf.getByRole("button", { name: "+ Add Lane" })).toBeVisible();

      await dtf.getByRole("button", { name: "+ Add Lane" }).click();
      await expect(dtf.getByLabel("Lane T5 label", { exact: true })).toHaveValue("T5");
      await expect(dtf.getByRole("checkbox", { name: "Active" })).toHaveCount(5);

      await dtf.getByRole("button", { name: "Manage Lanes", exact: true }).click();
      await dtf.getByRole("button", { name: "Manage Quantities" }).click();
      await expect(dtf.getByRole("button", { name: "+ Add Tier" })).toBeVisible();
      await dtf.getByRole("button", { name: "+ Add Tier" }).click();
      await expect(dtf.getByText("24 quantities", { exact: true })).toBeVisible();
      await expect(dtf.getByRole("button", { name: /Delete tier 2600\+/ })).toBeVisible();
    });

    test("accurately identifies preview-only mode and exposes no persistence actions", async ({
      errorFreePage: page,
    }) => {
      await openPricing(page);
      const dtf = dtfSection(page);

      await expect(
        dtf.getByText(/Preview Only.*Persistence is disabled\. Changes cannot be saved\./i)
      ).toBeVisible();
      await dtf.getByRole("button", { name: "Edit Matrix" }).click();
      await expect(dtf.getByText("Preview Only", { exact: true })).toBeVisible();

      await expect(page.getByRole("button", { name: /save|publish|upload/i })).toHaveCount(0);
      await expect(page.getByRole("link", { name: /save|publish|upload/i })).toHaveCount(0);
    });

    test("Catalog Operations page still renders correctly", async ({
      errorFreePage: page,
    }) => {
      await page.goto("/admin");
      await expect(page.getByText(/catalog operations/i).first()).toBeVisible();
      await expect(page.getByText(/private preview/i).first()).toBeVisible();
    });

    test("has no page-level horizontal overflow at 390x844", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openPricing(page);

      const mobileTiers = page.getByTestId("dtf-mobile-tier-cards");
      const defaultCard = mobileTiers.getByRole("button", {
        name: "Select quantity 144-249",
        exact: true,
      });
      const collapsedCard = mobileTiers.getByRole("button", {
        name: "Select quantity 72-143",
        exact: true,
      });

      await expect(page.getByTestId("dtf-matrix-table-panel")).toHaveCount(0);
      await expect(page.getByTestId("dtf-quantity-inspector")).toHaveCount(0);
      await expect(mobileTiers).toBeVisible();
      await expect(defaultCard).toHaveAttribute("aria-expanded", "true");
      await expect(collapsedCard).toHaveAttribute("aria-expanded", "false");
      await expect(collapsedCard.getByText(/^\$\d+\.\d{2}$/)).toBeVisible();
      await expect(collapsedCard.getByText(/^T1 · \d+\.\d% GM$/)).toBeVisible();
      await dtfSection(page).getByRole("button", { name: "Edit Matrix" }).click();
      await expect(
        mobileTiers.getByRole("heading", { name: "Quantity Configuration" })
      ).toBeVisible();
      await expect(
        mobileTiers.getByTitle("Display label for this quantity row", { exact: true })
      ).toBeEditable();
      await expect(
        mobileTiers.getByLabel("Tier 144-249 min qty", { exact: true })
      ).toBeEditable();
      await expect(
        mobileTiers.getByLabel("Tier 144-249 max qty", { exact: true })
      ).toBeEditable();
      await expect(
        mobileTiers.getByRole("button", { name: "Delete tier 144-249", exact: true })
      ).toBeVisible();
      await expect(page.getByTestId("ap-mobile-card-list")).toBeVisible();
      await expect(page.getByTestId("ap-desktop-table-panel")).toHaveCount(0);

      const dimensions = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        viewport: window.innerWidth,
      }));

      expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
      expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
    });
  });
});
