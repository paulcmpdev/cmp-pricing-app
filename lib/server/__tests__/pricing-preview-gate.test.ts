import { afterEach, describe, expect, it } from "vitest";
import {
  isPricingPreviewEnabled,
  isAdditionalLocationsPreviewEnabled,
} from "../pricing-preview-gate";

const env = process.env as Record<string, string | undefined>;
const original = {
  NODE_ENV: env.NODE_ENV,
  VERCEL_ENV: env.VERCEL_ENV,
  CMP_ENABLE_PRICING_PREVIEW: env.CMP_ENABLE_PRICING_PREVIEW,
  CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW:
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW,
};

afterEach(() => {
  env.NODE_ENV = original.NODE_ENV;
  env.VERCEL_ENV = original.VERCEL_ENV;
  env.CMP_ENABLE_PRICING_PREVIEW = original.CMP_ENABLE_PRICING_PREVIEW;
  env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW =
    original.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW;
});

describe("pricing preview gate", () => {
  it("fails closed without the explicit flag", () => {
    env.NODE_ENV = "development";
    env.VERCEL_ENV = undefined;
    delete env.CMP_ENABLE_PRICING_PREVIEW;

    expect(isPricingPreviewEnabled()).toBe(false);
  });

  it("allows local development and test only when flagged", () => {
    env.CMP_ENABLE_PRICING_PREVIEW = "true";
    env.VERCEL_ENV = undefined;

    env.NODE_ENV = "development";
    expect(isPricingPreviewEnabled()).toBe(true);

    env.NODE_ENV = "test";
    expect(isPricingPreviewEnabled()).toBe(true);
  });

  it("allows Vercel Preview when flagged", () => {
    env.NODE_ENV = "production";
    env.VERCEL_ENV = "preview";
    env.CMP_ENABLE_PRICING_PREVIEW = "true";

    expect(isPricingPreviewEnabled()).toBe(true);
  });

  it("stays disabled for Vercel production even when flagged", () => {
    env.NODE_ENV = "production";
    env.VERCEL_ENV = "production";
    env.CMP_ENABLE_PRICING_PREVIEW = "true";

    expect(isPricingPreviewEnabled()).toBe(false);
  });
});

describe("additional locations preview gate", () => {
  it("fails closed without the explicit flag", () => {
    env.NODE_ENV = "development";
    env.VERCEL_ENV = undefined;
    delete env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW;

    expect(isAdditionalLocationsPreviewEnabled()).toBe(false);
  });

  it("allows local development and test only when flagged", () => {
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW = "true";
    env.VERCEL_ENV = undefined;

    env.NODE_ENV = "development";
    expect(isAdditionalLocationsPreviewEnabled()).toBe(true);

    env.NODE_ENV = "test";
    expect(isAdditionalLocationsPreviewEnabled()).toBe(true);
  });

  it("allows Vercel Preview when flagged", () => {
    env.NODE_ENV = "production";
    env.VERCEL_ENV = "preview";
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW = "true";

    expect(isAdditionalLocationsPreviewEnabled()).toBe(true);
  });

  it("stays disabled for Vercel production even when flagged", () => {
    env.NODE_ENV = "production";
    env.VERCEL_ENV = "production";
    env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW = "true";

    expect(isAdditionalLocationsPreviewEnabled()).toBe(false);
  });

  it("is independent of the DTF pricing preview flag", () => {
    env.NODE_ENV = "development";
    env.VERCEL_ENV = undefined;
    env.CMP_ENABLE_PRICING_PREVIEW = "true";
    delete env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW;

    expect(isPricingPreviewEnabled()).toBe(true);
    expect(isAdditionalLocationsPreviewEnabled()).toBe(false);
  });
});
