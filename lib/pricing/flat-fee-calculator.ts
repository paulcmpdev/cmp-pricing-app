import "server-only";
import { d, roundUpToIncrement, ceilToWholeDollar } from "./money";
import { calculatePooledFlatFee } from "./pooled-flat-fee-engine";
import { flatFeeBillableQuantity } from "./quantity";
import contract from "@/lib/fixtures/pricing-contract.json";
import type { FlatFeeInput, FlatFeeOutput } from "./schemas";

const OPERATOR_WAGE = d(contract.labor.operatorWagePerHour);
const DESIGNER_WAGE = d(contract.labor.designerWagePerHour);
const ENGINE_MARGIN = d(contract.pooledDtfPolicy.engineMargin);
const ROUNDING_INCREMENT = d(contract.pricingPolicy.roundingIncrement);
const MODELED_QUANTITIES = contract.pooledDtfPolicy.modeledQuantities;

const services = contract.flatFeeServices;

/**
 * Compute session-level extra labor delta per shirt.
 */
function sessionLaborDelta(
  extraOperatorMinutesPerShirt: number,
  extraDesignerMinutesPerOrder: number,
  quantity: number
): number {
  const extraOpLabor = d(extraOperatorMinutesPerShirt)
    .div(60)
    .times(OPERATOR_WAGE);
  const extraDesLabor = d(extraDesignerMinutesPerOrder)
    .div(60)
    .times(DESIGNER_WAGE)
    .div(quantity);
  return extraOpLabor.plus(extraDesLabor).toNumber();
}

/**
 * Select worst-case COGS and engine price across modeled quantities 12-23,
 * applying session extra labor as a transparent delta on the shared engine.
 */
function computeWorstCaseEngine(
  service: string,
  extraOperatorMinutesPerShirt: number,
  extraDesignerMinutesPerOrder: number
): { engineCogs: number; enginePrice: number } {
  let worstCogs = -Infinity;
  let worstPrice = -Infinity;

  for (const qty of MODELED_QUANTITIES) {
    const pooled = calculatePooledFlatFee({ service, quantity: qty });
    const delta = sessionLaborDelta(
      extraOperatorMinutesPerShirt,
      extraDesignerMinutesPerOrder,
      qty
    );
    const cogs = d(pooled.incrementalCogsPerShirt).plus(delta).toNumber();
    const rawT1 = d(cogs).div(d(1).minus(ENGINE_MARGIN));
    const t1Price = roundUpToIncrement(rawT1, ROUNDING_INCREMENT).toNumber();
    const engineWhole = ceilToWholeDollar(t1Price);

    if (cogs > worstCogs) worstCogs = cogs;
    if (engineWhole > worstPrice) worstPrice = engineWhole;
  }

  return { engineCogs: worstCogs, enginePrice: worstPrice };
}

export function calculateFlatFeePrice(input: FlatFeeInput): FlatFeeOutput {
  const svc = services.find((s) => s.service === input.service);
  if (!svc) throw new Error(`Unknown flat-fee service: ${input.service}`);

  const billableQuantity = flatFeeBillableQuantity(input.orderQuantity);

  const { engineCogs, enginePrice } = computeWorstCaseEngine(
    input.service,
    input.extraOperatorMinutesPerShirt,
    input.extraDesignerMinutesPerOrder
  );

  const policyFloor = svc.policyFloor;

  // Recompute session-specific COGS at billable quantity via shared engine + delta
  const pooledAtBillable = calculatePooledFlatFee({
    service: input.service,
    quantity: billableQuantity,
  });
  const delta = sessionLaborDelta(
    input.extraOperatorMinutesPerShirt,
    input.extraDesignerMinutesPerOrder,
    billableQuantity
  );
  const sessionCogs = d(pooledAtBillable.incrementalCogsPerShirt)
    .plus(delta)
    .toNumber();

  // Determine effective price: manual override > max(policy floor, engine price)
  let effectivePrice: number;
  let status: string;

  if (input.manualOverride != null) {
    effectivePrice = input.manualOverride;
    status = "Manual override";
  } else if (policyFloor > enginePrice) {
    effectivePrice = policyFloor;
    status = "Policy floor";
  } else {
    effectivePrice = enginePrice;
    status = "Engine price";
  }

  const grossMargin = d(effectivePrice).minus(sessionCogs).div(effectivePrice);
  const addOnTotal = d(effectivePrice).times(billableQuantity);

  // Display extra labor (session-level extras only for Manager display)
  const extraOperatorLabor = d(input.extraOperatorMinutesPerShirt)
    .div(60)
    .times(OPERATOR_WAGE)
    .toNumber();
  const extraDesignerLabor = d(input.extraDesignerMinutesPerOrder)
    .div(60)
    .times(DESIGNER_WAGE)
    .div(billableQuantity)
    .toNumber();

  return {
    service: svc.service,
    engineCogs: sessionCogs,
    enginePrice,
    policyFloor,
    effectivePrice,
    grossMargin: grossMargin.toNumber(),
    status,
    billableQuantity,
    addOnTotal: addOnTotal.toNumber(),
    operatorOperatingCost: pooledAtBillable.operatorOperatingCost,
    extraOperatorLabor,
    extraDesignerLabor,
  };
}
