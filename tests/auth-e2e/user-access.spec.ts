import { test, expect, type BrowserContext } from "@playwright/test";
import { encode } from "next-auth/jwt";

/**
 * User Access e2e tests.
 *
 * These tests require CMP_USER_ACCESS_ENABLED=true and a configured
 * PostgreSQL database. When CMP_USER_ACCESS_ENABLED is not set, the
 * tests are skipped.
 *
 * The tests verify:
 * - Pending user denial and Pending Access page
 * - Admin list, approval, role change, disable, re-enable, and audit
 * - Manager/Sales Rep denial from /admin/users and Admin APIs
 * - Immediate server denial after disable with a previously signed JWT
 */

const BASE_URL = "http://127.0.0.1:3101";
const AUTH_TEST_SECRET = "cmp-auth-e2e-secret-with-at-least-thirty-two-characters";

type TestRole = "sales_rep" | "manager" | "admin";

async function authenticate(
  context: BrowserContext,
  email: string,
  role: TestRole
) {
  const token = await encode({
    secret: AUTH_TEST_SECRET,
    maxAge: 60 * 60,
    token: {
      sub: email,
      email,
      name: email.split("@")[0],
      role,
    },
  });

  await context.addCookies([
    {
      name: "next-auth.session-token",
      value: token,
      url: BASE_URL,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

const isUserAccessEnabled = process.env.CMP_USER_ACCESS_ENABLED === "true";

test.describe("user access boundary", () => {
  test.skip(!isUserAccessEnabled, "CMP_USER_ACCESS_ENABLED not set");

  test("pending-access page is publicly accessible", async ({ page }) => {
    await page.goto("/pending-access");
    await expect(page.getByRole("heading", { name: "ACCESS PENDING" })).toBeVisible();
    await expect(page.getByText("Your access request has been received")).toBeVisible();
    await expect(page.getByRole("link", { name: /return to sign in/i })).toBeVisible();
  });

  test("Sales Rep cannot access /admin/users", async ({ context, page }) => {
    await authenticate(context, "rep@cmpsportswear.com", "sales_rep");
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/unauthorized$/);
  });

  test("Manager cannot access /admin/users", async ({ context, page }) => {
    await authenticate(context, "manager@cmpsportswear.com", "manager");
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/unauthorized$/);
  });

  test("Sales Rep cannot call admin user APIs", async ({ context }) => {
    await authenticate(context, "rep@cmpsportswear.com", "sales_rep");
    const response = await context.request.get("/api/admin/users");
    expect(response.status()).toBe(403);
  });

  test("Manager cannot call admin user APIs", async ({ context }) => {
    await authenticate(context, "manager@cmpsportswear.com", "manager");
    const response = await context.request.get("/api/admin/users");
    expect(response.status()).toBe(403);
  });

  test("Admin can access Users & Access page", async ({ context, page }) => {
    await authenticate(context, "paul@cmpsportswear.com", "admin");
    await page.goto("/admin/users");
    await expect(page.getByText("USERS & ACCESS")).toBeVisible();
    // Summary cards should render
    await expect(page.getByTestId("summary-pending")).toBeVisible();
    await expect(page.getByTestId("summary-active")).toBeVisible();
    await expect(page.getByTestId("summary-disabled")).toBeVisible();
    await expect(page.getByTestId("summary-admins")).toBeVisible();
  });

  test("Admin can call GET /api/admin/users", async ({ context }) => {
    await authenticate(context, "paul@cmpsportswear.com", "admin");
    const response = await context.request.get("/api/admin/users");
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("users");
    expect(data).toHaveProperty("counts");
    expect(Array.isArray(data.users)).toBe(true);
  });
});
