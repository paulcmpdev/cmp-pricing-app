import { test } from "@playwright/test";

test.describe("Admin Panel Screenshots", () => {
  test("desktop 1440x900", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/admin");
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: "/tmp/cmp-admin-panel-desktop.png",
      fullPage: true,
    });
  });

  test("tablet 768x1024", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/admin");
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: "/tmp/cmp-admin-panel-tablet.png",
      fullPage: true,
    });
  });

  test("mobile 390x844", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/admin");
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: "/tmp/cmp-admin-panel-mobile.png",
      fullPage: true,
    });
  });
});
