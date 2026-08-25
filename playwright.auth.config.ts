import { defineConfig, devices } from "@playwright/test";

const PORT = 3101;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH_TEST_SECRET = "cmp-auth-e2e-secret-with-at-least-thirty-two-characters";

export default defineConfig({
  testDir: "./tests/auth-e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "html",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "authenticated-chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `npx next dev -H 127.0.0.1 -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      VERCEL_ENV: "production",
      CMP_AUTH_ENABLED: "true",
      CMP_ALLOWED_GOOGLE_DOMAIN: "cmpsportswear.com",
      CMP_ADMIN_EMAILS: "paul@cmpsportswear.com",
      CMP_MANAGER_EMAILS: "manager@cmpsportswear.com",
      CMP_ENABLE_AUTHENTICATED_PRODUCTION_FEATURES: "true",
      CMP_ENABLE_PRICING_PREVIEW: "true",
      CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW: "true",
      GOOGLE_CLIENT_ID: "auth-e2e-client-id",
      GOOGLE_CLIENT_SECRET: "auth-e2e-client-secret",
      NEXTAUTH_URL: BASE_URL,
      NEXTAUTH_SECRET: AUTH_TEST_SECRET,
    },
  },
});

export { AUTH_TEST_SECRET, BASE_URL };
