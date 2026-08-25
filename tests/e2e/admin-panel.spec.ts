import { test, expect } from "./fixtures";

test.describe("Admin Panel - Catalog Operations", () => {
  test("renders admin identity and branding", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/admin");
    await expect(page.locator("header h1")).toContainText("CATALOG OPERATIONS");
  });

  test("has Quote Desk navigation link", async ({ errorFreePage: page }) => {
    await page.goto("/admin");
    const link = page.getByRole("link", { name: /quote desk/i });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/");
  });

  test("shows private preview / read-only context", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/admin");
    await expect(page.getByText(/private preview/i).first()).toBeVisible();
    await expect(page.getByText(/read.only/i).first()).toBeVisible();
  });

  test("renders unavailable state safely without database", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "Catalog Unavailable" })
    ).toBeVisible();
    await expect(
      page.getByText("The vendor catalog overview is unavailable.")
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Refresh Now" })
    ).toBeDisabled();
  });

  test("has disabled operations controls", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/admin");
    const refreshBtn = page.getByRole("button", { name: /refresh now/i });
    const cancelBtn = page.getByRole("button", { name: /cancel/i });
    const retryBtn = page.getByRole("button", { name: /retry/i });
    const rollbackBtn = page.getByRole("button", { name: /rollback/i });

    await expect(refreshBtn).toBeVisible();
    await expect(refreshBtn).toBeDisabled();
    await expect(cancelBtn).toBeVisible();
    await expect(cancelBtn).toBeDisabled();
    await expect(retryBtn).toBeVisible();
    await expect(retryBtn).toBeDisabled();
    await expect(rollbackBtn).toBeVisible();
    await expect(rollbackBtn).toBeDisabled();
  });

  test("does not expose sensitive data labels", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/admin");
    const bodyText = await page.locator("main").textContent();
    const sensitiveLabels = [
      "Vendor Cost",
      "credentials",
      "Import ID",
      "Job ID",
      "Error Summary",
      "Requested By",
      "Rollback Reason",
      "API Key",
      "Bearer",
      "password",
    ];
    for (const label of sensitiveLabels) {
      expect(
        bodyText?.toLowerCase().includes(label.toLowerCase()),
        `Page should not contain "${label}"`
      ).toBe(false);
    }
  });

  test("no horizontal overflow at desktop 1440x900", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/admin");
    await page.waitForLoadState("networkidle");
    const bodyScrollWidth = await page.evaluate(
      () => document.body.scrollWidth
    );
    const windowInnerWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyScrollWidth).toBeLessThanOrEqual(windowInnerWidth + 1);
  });

  test("no horizontal overflow at tablet 768x1024", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/admin");
    await page.waitForLoadState("networkidle");
    const bodyScrollWidth = await page.evaluate(
      () => document.body.scrollWidth
    );
    const windowInnerWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyScrollWidth).toBeLessThanOrEqual(windowInnerWidth + 1);
  });

  test("no horizontal overflow at mobile 390x844", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/admin");
    await page.waitForLoadState("networkidle");
    const bodyScrollWidth = await page.evaluate(
      () => document.body.scrollWidth
    );
    const windowInnerWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyScrollWidth).toBeLessThanOrEqual(windowInnerWidth + 1);
  });
});

test.describe("Root page Admin navigation", () => {
  test("root Quote Desk header has Admin link", async ({
    errorFreePage: page,
  }) => {
    await page.goto("/");
    const adminLink = page.getByRole("link", { name: /admin/i });
    await expect(adminLink).toBeVisible();
    await expect(adminLink).toHaveAttribute("href", "/admin");
  });

  test("navigation works both ways", async ({ errorFreePage: page }) => {
    // From root to admin
    await page.goto("/");
    await page.getByRole("link", { name: /admin/i }).click();
    await expect(page).toHaveURL(/\/admin/);
    await expect(page.locator("header h1")).toContainText("CATALOG OPERATIONS");

    // From admin back to Quote Desk
    await page.getByRole("link", { name: /quote desk/i }).click();
    await expect(page).toHaveURL("/");
    await expect(page.locator("header h1")).toContainText("QUOTE DESK");
  });
});
