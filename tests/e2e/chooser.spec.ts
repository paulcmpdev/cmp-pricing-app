import { test, expect } from "./fixtures";

test.describe("Concept Chooser Page", () => {
  test("shows all three concept cards with working links", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts");

    // Title visible
    await expect(page.getByRole("heading", { name: "Pricing Concepts" })).toBeVisible();

    // Three concept cards are present
    const quoteDesk = page.getByRole("link", { name: /Quote Desk/i });
    const guidedBuilder = page.getByRole("link", { name: /Guided Builder/i });
    const commandCenter = page.getByRole("link", { name: /Command Center/i });

    await expect(quoteDesk).toBeVisible();
    await expect(guidedBuilder).toBeVisible();
    await expect(commandCenter).toBeVisible();

    // Verify hrefs
    await expect(quoteDesk).toHaveAttribute("href", "/concepts/quote-desk");
    await expect(guidedBuilder).toHaveAttribute("href", "/concepts/guided-builder");
    await expect(commandCenter).toHaveAttribute("href", "/concepts/command-center");
  });

  test("Quote Desk link navigates to quote desk page", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts");
    await page.getByRole("link", { name: /Quote Desk/i }).click();
    await page.waitForURL(/\/concepts\/quote-desk/);
    await expect(page.locator("header h1")).toContainText("QUOTE DESK");
  });

  test("Guided Builder link navigates to guided builder page", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts");
    await page.getByRole("link", { name: /Guided Builder/i }).click();
    await page.waitForURL(/\/concepts\/guided-builder/);
    await expect(page.locator("header h1")).toContainText("GUIDED BUILDER");
  });

  test("Command Center link navigates to command center page", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/concepts");
    await page.getByRole("link", { name: /Command Center/i }).click();
    await page.waitForURL(/\/concepts\/command-center/);
    await expect(page.locator("header h1")).toContainText("COMMAND CENTER");
  });
});
