import "server-only";
import contract from "@/lib/fixtures/pricing-contract.json";
import type { Tier } from "./schemas";

const tierMatrix: Tier[] = contract.dtfEngine.tierPriceMatrix;

export function lookupTier(quantity: number): Tier {
  const tier = tierMatrix.find((t) => quantity >= t.minQty && quantity <= t.maxQty);
  if (!tier) throw new Error(`No tier found for quantity ${quantity}`);
  return tier;
}
