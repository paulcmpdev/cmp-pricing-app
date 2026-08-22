import "server-only";
import contract from "@/lib/fixtures/pricing-contract.json";

const FLAT_FEE_MINIMUM = contract.pricingPolicy.flatFeeMinimumBillableQuantity;
const MANAGER_REVIEW_THRESHOLD =
  contract.inputConstraints.quantity.maximumWithoutManagerReview;

export interface QuantityValidation {
  valid: boolean;
  error?: string;
  requiresManagerReview: boolean;
}

export function validateQuantity(quantity: number): QuantityValidation {
  if (!Number.isInteger(quantity) || quantity < 1) {
    return {
      valid: false,
      error: "Quantity must be a positive whole number.",
      requiresManagerReview: false,
    };
  }
  return {
    valid: true,
    requiresManagerReview: quantity > MANAGER_REVIEW_THRESHOLD,
  };
}

export function flatFeeBillableQuantity(orderQuantity: number): number {
  return Math.max(orderQuantity, FLAT_FEE_MINIMUM);
}
