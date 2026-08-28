import { describe, it, expect } from "vitest";
import { isPricingConfigEnabled } from "../gate";

describe("isPricingConfigEnabled", () => {
  it("returns false when env is empty", () => {
    expect(isPricingConfigEnabled({})).toBe(false);
  });

  it("returns false when not set to true", () => {
    expect(isPricingConfigEnabled({ CMP_PRICING_CONFIG_ENABLED: "false" })).toBe(false);
  });

  it("returns true when set to true", () => {
    expect(isPricingConfigEnabled({ CMP_PRICING_CONFIG_ENABLED: "true" })).toBe(true);
  });
});
