import "server-only";
import contract from "@/lib/fixtures/pricing-contract.json";
import type { Tier } from "./schemas";

const tierMatrix: Tier[] = contract.dtfEngine.tierPriceMatrix;

export function lookupTier(quantity: number): Tier {
  const tier = tierMatrix.find((t) => quantity >= t.minQty && quantity <= t.maxQty);
  if (!tier) throw new Error(`No tier found for quantity ${quantity}`);
  return tier;
}

/**
 * Look up a tier from a dynamic tier list (from active pricing config).
 * Supports open-ended final tier where maxQty is null.
 * Falls back to the static contract tier matrix when no dynamic tiers are provided.
 */
export function lookupTierFromConfig(
  quantity: number,
  dynamicTiers?: Array<{ tier: string; minQty: number; maxQty: number | null; prices: Record<string, number> }>
): { tier: string; minQty: number; maxQty: number | null; prices: Record<string, number> } {
  const tiers = dynamicTiers ?? tierMatrix;
  const tier = tiers.find((t) =>
    quantity >= t.minQty && (t.maxQty === null || quantity <= t.maxQty)
  );
  if (!tier) throw new Error(`No tier found for quantity ${quantity}`);
  return tier;
}
