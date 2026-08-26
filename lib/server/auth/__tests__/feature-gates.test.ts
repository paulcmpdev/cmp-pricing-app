import { afterEach, describe, expect, it } from "vitest";

/**
 * Production feature gate tests.
 *
 * Features in production require:
 *   CMP_AUTH_ENABLED=true
 *   + CMP_ENABLE_AUTHENTICATED_PRODUCTION_FEATURES=true
 *   + individual feature flag
 *
 * Protected preview behavior (auth disabled) is preserved.
 */

import {
  isPricingPreviewEnabled,
  isAdditionalLocationsPreviewEnabled,
} from "../../pricing-preview-gate";

const env = process.env as Record<string, string | undefined>;

const KEYS = [
  "NODE_ENV",
  "VERCEL_ENV",
  "CMP_AUTH_ENABLED",
  "CMP_ENABLE_AUTHENTICATED_PRODUCTION_FEATURES",
  "CMP_ENABLE_PRICING_PREVIEW",
  "CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW",
] as const;

const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

describe("production feature gates with auth", () => {
  it("pricing preview is enabled in production when auth + production features + flag all true", () => {
    env.NODE_ENV = "production";
    env.VERCEL_ENV = "production";
    env.CMP_AUTH_ENABLED = "true";
    env.CMP_ENABLE_AUTHENTICATED_PRODUCTION_FEATURES = "true";
    env.CMP_ENABLE_PRICING_PREVIEW = "true";

    expect(isPricingPreviewEnabled()).toBe(true);
  });

  it("additional locations preview is enabled in production when auth + production features + flag all true", () => {
    env.NODE_ENV = "production";
    env.VERCEL_ENV = "production";
    env.CMP_AUTH_ENABLED = "true";
    env.CMP_ENABLE_AUTHENTICATED_PRODUCTION_FEATURES = "true";
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW = "true";

    expect(isAdditionalLocationsPreviewEnabled()).toBe(true);
  });

  it("pricing preview stays disabled in production without auth", () => {
    env.NODE_ENV = "production";
    env.VERCEL_ENV = "production";
    delete env.CMP_AUTH_ENABLED;
    env.CMP_ENABLE_AUTHENTICATED_PRODUCTION_FEATURES = "true";
    env.CMP_ENABLE_PRICING_PREVIEW = "true";

    expect(isPricingPreviewEnabled()).toBe(false);
  });

  it("pricing preview stays disabled in production without production features flag", () => {
    env.NODE_ENV = "production";
    env.VERCEL_ENV = "production";
    env.CMP_AUTH_ENABLED = "true";
    delete env.CMP_ENABLE_AUTHENTICATED_PRODUCTION_FEATURES;
    env.CMP_ENABLE_PRICING_PREVIEW = "true";

    expect(isPricingPreviewEnabled()).toBe(false);
  });

  it("pricing preview stays disabled in production without individual flag", () => {
    env.NODE_ENV = "production";
    env.VERCEL_ENV = "production";
    env.CMP_AUTH_ENABLED = "true";
    env.CMP_ENABLE_AUTHENTICATED_PRODUCTION_FEATURES = "true";
    delete env.CMP_ENABLE_PRICING_PREVIEW;

    expect(isPricingPreviewEnabled()).toBe(false);
  });

  it("protected preview still works when auth is disabled (existing behavior)", () => {
    env.NODE_ENV = "production";
    env.VERCEL_ENV = "preview";
    delete env.CMP_AUTH_ENABLED;
    env.CMP_ENABLE_PRICING_PREVIEW = "true";

    expect(isPricingPreviewEnabled()).toBe(true);
  });

  it("local dev still works when auth is disabled (existing behavior)", () => {
    env.NODE_ENV = "development";
    delete env.VERCEL_ENV;
    delete env.CMP_AUTH_ENABLED;
    env.CMP_ENABLE_PRICING_PREVIEW = "true";

    expect(isPricingPreviewEnabled()).toBe(true);
  });

  it("test environment still works when auth is disabled (existing behavior)", () => {
    env.NODE_ENV = "test";
    delete env.VERCEL_ENV;
    delete env.CMP_AUTH_ENABLED;
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW = "true";

    expect(isAdditionalLocationsPreviewEnabled()).toBe(true);
  });
});
