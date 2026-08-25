import { defineConfig, devices } from "@playwright/test";

const PORT = 3099;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    env: {
      ...process.env,
      CMP_ALLOW_LOCAL_MANAGER_MODE: "true",
      CMP_ENABLE_PRICING_PREVIEW: "true",
      CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW: "true",
    },
  },
});
