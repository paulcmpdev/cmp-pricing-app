/**
 * Server-only quote services.
 *
 * These functions call into the shared pricing engine and shape the output
 * for Staff or Manager consumers. Raw wages, COGS, and internal engine
 * fields never leave this module in Staff mode.
 */
import "server-only";

import { calculateItemPrice } from "@/lib/pricing/item-calculator";
import { calculateFlatFeePrice } from "@/lib/pricing/flat-fee-calculator";
import type { ItemPriceInput, FlatFeeInput } from "@/lib/pricing/schemas";
import type {
  StaffItemQuoteResponse,
  ManagerItemQuoteResponse,
  StaffFlatFeeQuoteResponse,
  ManagerFlatFeeQuoteResponse,
} from "./quote-types";

// ---------------------------------------------------------------------------
// Item Price
// ---------------------------------------------------------------------------

export function quoteItemStaff(input: ItemPriceInput): StaffItemQuoteResponse {
  const full = calculateItemPrice(input);
  return {
    productSell: full.productSell,
    decorationSell: full.decorationSell,
    salesPrice: full.salesPrice,
    salesOrderTotal: full.salesOrderTotal,
    tierLabel: full.tierLabel,
  };
}

export function quoteItemManager(input: ItemPriceInput): ManagerItemQuoteResponse {
  return calculateItemPrice(input);
}

// ---------------------------------------------------------------------------
// Flat-Fee
// ---------------------------------------------------------------------------

export function quoteFlatFeeStaff(input: FlatFeeInput): StaffFlatFeeQuoteResponse {
  const full = calculateFlatFeePrice(input);
  return {
    service: full.service,
    effectivePrice: full.effectivePrice,
    status: full.status,
    billableQuantity: full.billableQuantity,
    addOnTotal: full.addOnTotal,
  };
}

export function quoteFlatFeeManager(input: FlatFeeInput): ManagerFlatFeeQuoteResponse {
  return calculateFlatFeePrice(input);
}
