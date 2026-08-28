import { test, expect } from "./fixtures";

test.describe("Concept Chooser Page", () => {
  test("shows the Quote Desk concept card with a working link", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts");

    // Title visible
    await expect(page.getByRole("heading", { name: "Pricing Concepts" })).toBeVisible();

    const quoteDesk = page.getByRole("link", { name: /Quote Desk/i });

    await expect(quoteDesk).toBeVisible();

    // Verify href
    await expect(quoteDesk).toHaveAttribute("href", "/concepts/quote-desk");
  });

  test("Quote Desk link navigates to quote desk page", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts");
    await page.getByRole("link", { name: /Quote Desk/i }).click();
    await page.waitForURL(/\/concepts\/quote-desk/);
    await expect(page.locator("header h1")).toContainText("QUOTE DESK");
  });
});
