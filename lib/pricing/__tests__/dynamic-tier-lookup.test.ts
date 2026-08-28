import { describe, it, expect } from "vitest";
import { lookupTier, lookupTierFromConfig } from "../tier-lookup";

describe("lookupTierFromConfig", () => {
  const dynamicTiers = [
    { tier: "1-10", minQty: 1, maxQty: 10, prices: { T1: 20, T2: 18 } },
    { tier: "11-50", minQty: 11, maxQty: 50, prices: { T1: 15, T2: 13 } },
    { tier: "51+", minQty: 51, maxQty: null, prices: { T1: 10, T2: 8 } },
  ];

  it("finds tier for qty in first range", () => {
    const tier = lookupTierFromConfig(5, dynamicTiers);
    expect(tier.tier).toBe("1-10");
    expect(tier.prices.T1).toBe(20);
  });

  it("finds tier for qty in middle range", () => {
    const tier = lookupTierFromConfig(25, dynamicTiers);
    expect(tier.tier).toBe("11-50");
  });

  it("finds tier for qty in open-ended last range", () => {
    const tier = lookupTierFromConfig(100, dynamicTiers);
    expect(tier.tier).toBe("51+");
  });

  it("finds tier at boundary", () => {
    const tier = lookupTierFromConfig(10, dynamicTiers);
    expect(tier.tier).toBe("1-10");

    const tier2 = lookupTierFromConfig(11, dynamicTiers);
    expect(tier2.tier).toBe("11-50");
  });

  it("handles quantities above 5000 with open-ended tier", () => {
    const tier = lookupTierFromConfig(10000, dynamicTiers);
    expect(tier.tier).toBe("51+");
    expect(tier.maxQty).toBeNull();
  });

  it("falls back to contract tiers when no dynamic tiers provided", () => {
    const tier = lookupTierFromConfig(84);
    expect(tier.tier).toBe("72-143");
    expect(tier.prices.T1).toBeDefined();
  });

  it("matches original lookupTier for contract data", () => {
    for (const qty of [1, 12, 24, 72, 250, 2500]) {
      const original = lookupTier(qty);
      const dynamic = lookupTierFromConfig(qty);
      expect(dynamic.tier).toBe(original.tier);
      expect(dynamic.prices.T1).toBe(original.prices.T1);
    }
  });
});
