import { afterEach, describe, expect, it } from "vitest";
import {
  isUserAccessEnabled,
  isBootstrapAdmin,
  resolveAccessFromUser,
  resolveAccessFallback,
} from "../access-resolution";
import type { AppUser } from "../../user-access/types";

const env = process.env as Record<string, string | undefined>;
const KEYS = ["CMP_USER_ACCESS_ENABLED", "CMP_ADMIN_EMAILS"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

function makeUser(overrides: Partial<AppUser> = {}): AppUser {
  return {
    email: "user@cmpsportswear.com",
    name: "User",
    image: null,
    role: "sales_rep",
    status: "active",
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastSignInAt: null,
    ...overrides,
  };
}

describe("isUserAccessEnabled", () => {
  it("returns false when CMP_USER_ACCESS_ENABLED is absent", () => {
    delete env.CMP_USER_ACCESS_ENABLED;
    expect(isUserAccessEnabled()).toBe(false);
  });

  it("returns true when CMP_USER_ACCESS_ENABLED is 'true'", () => {
    env.CMP_USER_ACCESS_ENABLED = "true";
    expect(isUserAccessEnabled()).toBe(true);
  });
});

describe("isBootstrapAdmin", () => {
  it("returns true for an email in CMP_ADMIN_EMAILS", () => {
    env.CMP_ADMIN_EMAILS = "paul@cmpsportswear.com";
    expect(isBootstrapAdmin("paul@cmpsportswear.com")).toBe(true);
  });

  it("returns false for a non-admin email", () => {
    env.CMP_ADMIN_EMAILS = "paul@cmpsportswear.com";
    expect(isBootstrapAdmin("other@cmpsportswear.com")).toBe(false);
  });

  it("normalizes case", () => {
    env.CMP_ADMIN_EMAILS = "Paul@CMPSportswear.com";
    expect(isBootstrapAdmin("paul@cmpsportswear.com")).toBe(true);
  });
});

describe("resolveAccessFromUser", () => {
  it("returns admin for bootstrap admin regardless of DB user", () => {
    env.CMP_ADMIN_EMAILS = "paul@cmpsportswear.com";
    const result = resolveAccessFromUser(
      "paul@cmpsportswear.com",
      makeUser({ status: "disabled", role: null })
    );
    expect(result).not.toBeNull();
    expect(result!.role).toBe("admin");
    expect(result!.isBootstrapAdmin).toBe(true);
  });

  it("returns admin for bootstrap admin even with null dbUser", () => {
    env.CMP_ADMIN_EMAILS = "paul@cmpsportswear.com";
    const result = resolveAccessFromUser("paul@cmpsportswear.com", null);
    expect(result).not.toBeNull();
    expect(result!.role).toBe("admin");
  });

  it("returns null for non-bootstrap user with no DB record", () => {
    env.CMP_ADMIN_EMAILS = "paul@cmpsportswear.com";
    const result = resolveAccessFromUser("other@cmpsportswear.com", null);
    expect(result).toBeNull();
  });

  it("returns null for pending user", () => {
    env.CMP_ADMIN_EMAILS = "paul@cmpsportswear.com";
    const result = resolveAccessFromUser(
      "other@cmpsportswear.com",
      makeUser({ status: "pending", role: null })
    );
    expect(result).toBeNull();
  });

  it("returns null for disabled user", () => {
    env.CMP_ADMIN_EMAILS = "paul@cmpsportswear.com";
    const result = resolveAccessFromUser(
      "other@cmpsportswear.com",
      makeUser({ status: "disabled" })
    );
    expect(result).toBeNull();
  });

  it("returns role for active user with role", () => {
    env.CMP_ADMIN_EMAILS = "paul@cmpsportswear.com";
    const result = resolveAccessFromUser(
      "manager@cmpsportswear.com",
      makeUser({ email: "manager@cmpsportswear.com", role: "manager" })
    );
    expect(result).not.toBeNull();
    expect(result!.role).toBe("manager");
    expect(result!.isBootstrapAdmin).toBe(false);
  });
});

describe("resolveAccessFallback", () => {
  it("returns admin for bootstrap admin", () => {
    env.CMP_ADMIN_EMAILS = "paul@cmpsportswear.com";
    const result = resolveAccessFallback("paul@cmpsportswear.com");
    expect(result).not.toBeNull();
    expect(result!.role).toBe("admin");
  });

  it("returns null for non-bootstrap user", () => {
    env.CMP_ADMIN_EMAILS = "paul@cmpsportswear.com";
    const result = resolveAccessFallback("other@cmpsportswear.com");
    expect(result).toBeNull();
  });
});
