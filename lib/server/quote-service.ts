/**
 * Server-only quote services.
 *
 * These functions call into the shared pricing engine and shape the output
 * for Staff or Manager consumers. Raw wages, COGS, and internal engine
 * fields never leave this module in Staff mode.
 */
import "server-only";

import { calculateItemPrice, type DynamicTier } from "@/lib/pricing/item-calculator";
import { d } from "@/lib/pricing/money";
import contract from "@/lib/fixtures/pricing-contract.json";
import type { ItemPriceInput } from "@/lib/pricing/schemas";
import type {
  StaffItemQuoteResponse,
  ManagerItemQuoteResponse,
  StaffFlatFeeQuoteResponse,
  ManagerFlatFeeQuoteResponse,
} from "./quote-types";
import type { AdditionalPrintService } from "./pricing-config/schemas";

// ---------------------------------------------------------------------------
// Item Price
// ---------------------------------------------------------------------------

export function quoteItemStaff(
  input: ItemPriceInput,
  dynamicTiers?: DynamicTier[]
): StaffItemQuoteResponse {
  const full = calculateItemPrice(input, dynamicTiers);
  return {
    productSell: full.productSell,
    decorationSell: full.decorationSell,
    salesPrice: full.salesPrice,
    salesOrderTotal: full.salesOrderTotal,
    tierLabel: full.tierLabel,
  };
}

export function quoteItemManager(
  input: ItemPriceInput,
  dynamicTiers?: DynamicTier[]
): ManagerItemQuoteResponse {
  return calculateItemPrice(input, dynamicTiers);
}

// ---------------------------------------------------------------------------
// Flat-Fee (config-driven path)
// ---------------------------------------------------------------------------

const OPERATOR_WAGE = d(contract.labor.operatorWagePerHour);
const DESIGNER_WAGE = d(contract.labor.designerWagePerHour);

export interface ConfigFlatFeeInput {
  serviceKey: string;
  orderQuantity: number;
  minimumBillableQuantity: number;
  /** Manager-only session controls. Staff callers must never populate these. */
  extraOperatorMinutesPerShirt?: number;
  extraDesignerMinutesPerOrder?: number;
  manualOverride?: number | null;
}

export function quoteFlatFeeFromConfigStaff(
  serviceConfig: AdditionalPrintService,
  input: ConfigFlatFeeInput
): StaffFlatFeeQuoteResponse {
  const billableQuantity = Math.max(
    input.orderQuantity,
    input.minimumBillableQuantity
  );
  const addOnTotal = d(serviceConfig.effectivePrice)
    .times(billableQuantity)
    .toNumber();

  return {
    service: serviceConfig.key,
    effectivePrice: serviceConfig.effectivePrice,
    billableQuantity,
    addOnTotal,
  };
}

export function quoteFlatFeeFromConfigManager(
  serviceConfig: AdditionalPrintService,
  input: ConfigFlatFeeInput
): ManagerFlatFeeQuoteResponse {
  const billableQuantity = Math.max(
    input.orderQuantity,
    input.minimumBillableQuantity
  );

  const extraOperatorMinutesPerShirt = input.extraOperatorMinutesPerShirt ?? 0;
  const extraDesignerMinutesPerOrder = input.extraDesignerMinutesPerOrder ?? 0;
  const manualOverride = input.manualOverride ?? null;

  const extraOperatorLabor = d(extraOperatorMinutesPerShirt)
    .div(60)
    .times(OPERATOR_WAGE)
    .toNumber();
  const extraDesignerLabor = d(extraDesignerMinutesPerOrder)
    .div(60)
    .times(DESIGNER_WAGE)
    .div(billableQuantity)
    .toNumber();

  // Session-local labor extras are audit metadata layered on top of the
  // admin-approved COGS baseline; they never change the effective price.
  const sessionCogs = d(serviceConfig.cogs)
    .plus(extraOperatorLabor)
    .plus(extraDesignerLabor)
    .toNumber();

  const effectivePrice =
    manualOverride != null ? manualOverride : serviceConfig.effectivePrice;
  const status = manualOverride != null ? "Manual override" : serviceConfig.status;

  const grossMargin =
    effectivePrice > 0
      ? d(effectivePrice).minus(sessionCogs).div(effectivePrice).toNumber()
      : 0;
  const addOnTotal = d(effectivePrice).times(billableQuantity).toNumber();

  return {
    service: serviceConfig.key,
    engineCogs: sessionCogs,
    enginePrice: serviceConfig.enginePrice,
    policyFloor: serviceConfig.policyFloor,
    effectivePrice,
    grossMargin,
    status,
    billableQuantity,
    addOnTotal,
    operatorOperatingCost: serviceConfig.operatorOperatingCost,
    extraOperatorLabor,
    extraDesignerLabor,
  };
}
