import { test, expect } from "./fixtures";

const VIEWPORTS = [
  { name: "iPhone 14 Pro", width: 390, height: 844 },
  { name: "iPad", width: 768, height: 1024 },
  { name: "Desktop", width: 1440, height: 900 },
] as const;

const ROUTES = [
  { path: "/", name: "Quote Desk Primary" },
  { path: "/concepts/quote-desk", name: "Quote Desk" },
] as const;

for (const viewport of VIEWPORTS) {
  for (const route of ROUTES) {
    test.describe(`${route.name} @ ${viewport.name} (${viewport.width}x${viewport.height})`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      test("loads without horizontal overflow", async ({
        errorFreePage: page,
      }) => {
        await page.goto(route.path);

        // Wait for the page to be interactive
        await page.waitForLoadState("networkidle");

        // Check for horizontal overflow: document width should not exceed viewport
        const bodyScrollWidth = await page.evaluate(
          () => document.body.scrollWidth
        );
        const windowInnerWidth = await page.evaluate(
          () => window.innerWidth
        );

        expect(
          bodyScrollWidth,
          `Body scroll width (${bodyScrollWidth}) should not exceed viewport width (${windowInnerWidth})`
        ).toBeLessThanOrEqual(windowInnerWidth + 1); // +1 for rounding
      });

      test("renders main heading visible", async ({
        errorFreePage: page,
      }) => {
        await page.goto(route.path);
        await page.waitForLoadState("networkidle");

        // Each page has a heading in the header
        const heading = page.locator("header h1");
        await expect(heading).toBeVisible();
      });
    });
  }
}
