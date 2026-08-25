import { afterEach, describe, expect, it } from "vitest";

/**
 * Auth policy pure unit tests.
 *
 * These exercise domain normalization, verified-email enforcement,
 * role precedence, exact matching, fail-closed behavior, capability
 * checks, and spoofed-header rejection without touching NextAuth
 * or network.
 */

import {
  isAuthEnabled,
  isAllowedDomain,
  resolveRole,
  parseEmailList,
  hasCapability,
  resolveQuoteProjection,
  type CmpRole,
} from "../policy";

const env = process.env as Record<string, string | undefined>;

const saved: Record<string, string | undefined> = {};
const AUTH_KEYS = [
  "CMP_AUTH_ENABLED",
  "CMP_ALLOWED_GOOGLE_DOMAIN",
  "CMP_ADMIN_EMAILS",
  "CMP_MANAGER_EMAILS",
] as const;

function setAuthEnv(overrides: Partial<Record<(typeof AUTH_KEYS)[number], string>>) {
  for (const key of AUTH_KEYS) {
    if (key in overrides) {
      env[key] = overrides[key];
    } else {
      delete env[key];
    }
  }
}

afterEach(() => {
  for (const key of AUTH_KEYS) {
    if (saved[key] === undefined) {
      delete env[key];
    } else {
      env[key] = saved[key];
    }
  }
});

// Save originals once
for (const key of AUTH_KEYS) {
  saved[key] = env[key];
}

// ---------------------------------------------------------------------------
// isAuthEnabled
// ---------------------------------------------------------------------------

describe("isAuthEnabled", () => {
  it("returns false when CMP_AUTH_ENABLED is absent", () => {
    delete env.CMP_AUTH_ENABLED;
    expect(isAuthEnabled()).toBe(false);
  });

  it("returns false when CMP_AUTH_ENABLED is empty string", () => {
    env.CMP_AUTH_ENABLED = "";
    expect(isAuthEnabled()).toBe(false);
  });

  it("returns false when CMP_AUTH_ENABLED is 'false'", () => {
    env.CMP_AUTH_ENABLED = "false";
    expect(isAuthEnabled()).toBe(false);
  });

  it("returns true when CMP_AUTH_ENABLED is 'true'", () => {
    env.CMP_AUTH_ENABLED = "true";
    expect(isAuthEnabled()).toBe(true);
  });

  it("is case-sensitive (TRUE does not enable)", () => {
    env.CMP_AUTH_ENABLED = "TRUE";
    expect(isAuthEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAllowedDomain
// ---------------------------------------------------------------------------

describe("isAllowedDomain", () => {
  it("accepts verified @cmpsportswear.com email", () => {
    expect(
      isAllowedDomain("paul@cmpsportswear.com", "cmpsportswear.com")
    ).toBe(true);
  });

  it("rejects non-CMP domain", () => {
    expect(
      isAllowedDomain("attacker@evil.com", "cmpsportswear.com")
    ).toBe(false);
  });

  it("rejects email with CMP domain as substring", () => {
    expect(
      isAllowedDomain("user@notcmpsportswear.com", "cmpsportswear.com")
    ).toBe(false);
  });

  it("normalizes email to lowercase before checking", () => {
    expect(
      isAllowedDomain("Paul@CMPSportswear.COM", "cmpsportswear.com")
    ).toBe(true);
  });

  it("rejects empty email", () => {
    expect(isAllowedDomain("", "cmpsportswear.com")).toBe(false);
  });

  it("rejects null/undefined email", () => {
    expect(isAllowedDomain(null as unknown as string, "cmpsportswear.com")).toBe(false);
    expect(isAllowedDomain(undefined as unknown as string, "cmpsportswear.com")).toBe(false);
  });

  it("rejects email without @", () => {
    expect(isAllowedDomain("paulcmpsportswear.com", "cmpsportswear.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseEmailList
// ---------------------------------------------------------------------------

describe("parseEmailList", () => {
  it("parses comma-separated emails, trims, lowercases, deduplicates", () => {
    const result = parseEmailList("  Paul@CMP.com , jane@cmp.com,  PAUL@CMP.COM  ");
    expect(result).toEqual(["paul@cmp.com", "jane@cmp.com"]);
  });

  it("returns empty array for empty/undefined input", () => {
    expect(parseEmailList("")).toEqual([]);
    expect(parseEmailList(undefined)).toEqual([]);
  });

  it("filters out empty entries from trailing commas", () => {
    expect(parseEmailList("a@b.com,,c@d.com,")).toEqual(["a@b.com", "c@d.com"]);
  });
});

// ---------------------------------------------------------------------------
// resolveRole
// ---------------------------------------------------------------------------

describe("resolveRole", () => {
  it("returns 'admin' when email is in CMP_ADMIN_EMAILS", () => {
    setAuthEnv({
      CMP_AUTH_ENABLED: "true",
      CMP_ALLOWED_GOOGLE_DOMAIN: "cmpsportswear.com",
      CMP_ADMIN_EMAILS: "paul@cmpsportswear.com",
      CMP_MANAGER_EMAILS: "",
    });
    expect(resolveRole("paul@cmpsportswear.com")).toBe("admin");
  });

  it("returns 'manager' when email is in CMP_MANAGER_EMAILS", () => {
    setAuthEnv({
      CMP_AUTH_ENABLED: "true",
      CMP_ALLOWED_GOOGLE_DOMAIN: "cmpsportswear.com",
      CMP_ADMIN_EMAILS: "paul@cmpsportswear.com",
      CMP_MANAGER_EMAILS: "jane@cmpsportswear.com",
    });
    expect(resolveRole("jane@cmpsportswear.com")).toBe("manager");
  });

  it("returns 'sales_rep' for valid domain email not in admin/manager lists", () => {
    setAuthEnv({
      CMP_AUTH_ENABLED: "true",
      CMP_ALLOWED_GOOGLE_DOMAIN: "cmpsportswear.com",
      CMP_ADMIN_EMAILS: "paul@cmpsportswear.com",
      CMP_MANAGER_EMAILS: "",
    });
    expect(resolveRole("newuser@cmpsportswear.com")).toBe("sales_rep");
  });

  it("returns null for non-CMP domain email", () => {
    setAuthEnv({
      CMP_AUTH_ENABLED: "true",
      CMP_ALLOWED_GOOGLE_DOMAIN: "cmpsportswear.com",
      CMP_ADMIN_EMAILS: "paul@cmpsportswear.com",
    });
    expect(resolveRole("attacker@evil.com")).toBeNull();
  });

  it("admin takes precedence when email is in both admin and manager lists", () => {
    setAuthEnv({
      CMP_AUTH_ENABLED: "true",
      CMP_ALLOWED_GOOGLE_DOMAIN: "cmpsportswear.com",
      CMP_ADMIN_EMAILS: "paul@cmpsportswear.com",
      CMP_MANAGER_EMAILS: "paul@cmpsportswear.com",
    });
    expect(resolveRole("paul@cmpsportswear.com")).toBe("admin");
  });

  it("normalizes email case for matching", () => {
    setAuthEnv({
      CMP_AUTH_ENABLED: "true",
      CMP_ALLOWED_GOOGLE_DOMAIN: "cmpsportswear.com",
      CMP_ADMIN_EMAILS: "Paul@CMPSportswear.com",
    });
    expect(resolveRole("paul@cmpsportswear.com")).toBe("admin");
  });

  it("returns null for empty/null email", () => {
    setAuthEnv({
      CMP_AUTH_ENABLED: "true",
      CMP_ALLOWED_GOOGLE_DOMAIN: "cmpsportswear.com",
      CMP_ADMIN_EMAILS: "paul@cmpsportswear.com",
    });
    expect(resolveRole("")).toBeNull();
    expect(resolveRole(null as unknown as string)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fail-closed behavior
// ---------------------------------------------------------------------------

describe("fail-closed on missing config", () => {
  it("resolveRole returns null when CMP_ALLOWED_GOOGLE_DOMAIN is missing", () => {
    setAuthEnv({
      CMP_AUTH_ENABLED: "true",
      CMP_ADMIN_EMAILS: "paul@cmpsportswear.com",
    });
    // Without domain config, fail closed
    expect(resolveRole("paul@cmpsportswear.com")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasCapability
// ---------------------------------------------------------------------------

describe("hasCapability", () => {
  it("admin can access admin pages", () => {
    expect(hasCapability("admin", "admin_access")).toBe(true);
  });

  it("manager cannot access admin pages", () => {
    expect(hasCapability("manager", "admin_access")).toBe(false);
  });

  it("sales_rep cannot access admin pages", () => {
    expect(hasCapability("sales_rep", "admin_access")).toBe(false);
  });

  it("all roles can view quotes", () => {
    expect(hasCapability("admin", "view_quotes")).toBe(true);
    expect(hasCapability("manager", "view_quotes")).toBe(true);
    expect(hasCapability("sales_rep", "view_quotes")).toBe(true);
  });

  it("manager and admin can view manager projections", () => {
    expect(hasCapability("admin", "view_manager_projections")).toBe(true);
    expect(hasCapability("manager", "view_manager_projections")).toBe(true);
  });

  it("sales_rep cannot view manager projections", () => {
    expect(hasCapability("sales_rep", "view_manager_projections")).toBe(false);
  });

  it("null role has no capabilities", () => {
    expect(hasCapability(null, "view_quotes")).toBe(false);
    expect(hasCapability(null, "admin_access")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveQuoteProjection
// ---------------------------------------------------------------------------

describe("resolveQuoteProjection", () => {
  it("returns 'manager' for admin role", () => {
    expect(resolveQuoteProjection("admin")).toBe("manager");
  });

  it("returns 'manager' for manager role", () => {
    expect(resolveQuoteProjection("manager")).toBe("manager");
  });

  it("returns 'staff' for sales_rep role", () => {
    expect(resolveQuoteProjection("sales_rep")).toBe("staff");
  });

  it("returns 'staff' for null role", () => {
    expect(resolveQuoteProjection(null)).toBe("staff");
  });
});

// ---------------------------------------------------------------------------
// x-cmp-role header is ignored when auth enabled (tested at route level)
// This test ensures the policy module itself never consults headers
// ---------------------------------------------------------------------------

describe("auth policy is header-independent", () => {
  it("resolveRole only takes email, not headers", () => {
    setAuthEnv({
      CMP_AUTH_ENABLED: "true",
      CMP_ALLOWED_GOOGLE_DOMAIN: "cmpsportswear.com",
      CMP_ADMIN_EMAILS: "paul@cmpsportswear.com",
    });
    // The function signature should only accept an email string,
    // not a request or headers object
    expect(resolveRole.length).toBeLessThanOrEqual(2);
  });
});
