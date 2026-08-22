/**
 * Shared Playwright fixtures that capture console errors and uncaught
 * page errors, failing the test if any are found.
 */
import { test as base, expect, type Page } from "@playwright/test";

type Fixtures = {
  /** A page that fails the test on console.error or page crashes. */
  errorFreePage: Page;
};

export const test = base.extend<Fixtures>({
  errorFreePage: async ({ page }, use) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    await use(page);

    // Filter out noisy Next.js dev-mode warnings that aren't real errors
    const real = [...consoleErrors, ...pageErrors].filter(
      (m) =>
        !m.includes("Fast Refresh") &&
        !m.includes("webpack") &&
        !m.includes("[HMR]") &&
        !m.includes("Download the React DevTools")
    );

    expect(real, "Unexpected console/page errors").toEqual([]);
  },
});

export { expect };
