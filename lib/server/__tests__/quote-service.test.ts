import { describe, it, expect } from "vitest";
import {
  quoteItemStaff,
  quoteItemManager,
  quoteFlatFeeStaff,
  quoteFlatFeeManager,
} from "../quote-service";
import {
  MANAGER_ONLY_ITEM_KEYS,
  MANAGER_ONLY_FLAT_FEE_KEYS,
} from "../quote-types";
import { calculateItemPrice } from "@/lib/pricing/item-calculator";
import { calculateFlatFeePrice } from "@/lib/pricing/flat-fee-calculator";
import {
  getItemForwardScenario,
  type ItemForwardOutputs,
} from "@/lib/fixtures/parity-scenario-types";

const EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Shared test inputs
// ---------------------------------------------------------------------------

const { inputs: itemInputs, outputs: expected } = getItemForwardScenario();

const ITEM_INPUT = {
  productCost: itemInputs.productCost,
  quantity: itemInputs.quantity,
  productCostMultiplier: itemInputs.productCostMultiplier,
  tierPriceLane: itemInputs.tierPriceLane as "T1" | "T2" | "T3" | "T4",
};

const FLAT_FEE_INPUT = {
  service: "Sleeve Print",
  orderQuantity: 12,
  extraOperatorMinutesPerShirt: 0,
  extraDesignerMinutesPerOrder: 0,
  manualOverride: null,
};

// ---------------------------------------------------------------------------
// Staff Item Quote: omits manager-only keys
// ---------------------------------------------------------------------------

describe("Staff item quote serialization boundary", () => {
  const staffResult = quoteItemStaff(ITEM_INPUT);

  it("includes customer-facing fields", () => {
    expect(staffResult).toHaveProperty("productSell");
    expect(staffResult).toHaveProperty("decorationSell");
    expect(staffResult).toHaveProperty("salesPrice");
    expect(staffResult).toHaveProperty("salesOrderTotal");
    expect(staffResult).toHaveProperty("tierLabel");
  });

  it.each(MANAGER_ONLY_ITEM_KEYS)(
    "omits manager-only key: %s",
    (key) => {
      expect(staffResult).not.toHaveProperty(key);
    }
  );

  it("has exactly 5 keys", () => {
    expect(Object.keys(staffResult)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Manager Item Quote: preserves all existing engine behavior
// ---------------------------------------------------------------------------

describe("Manager item quote preserves full engine output", () => {
  const managerResult = quoteItemManager(ITEM_INPUT);
  const directResult = calculateItemPrice(ITEM_INPUT);

  it("matches direct engine call exactly", () => {
    for (const key of Object.keys(directResult) as (keyof typeof directResult)[]) {
      expect(managerResult[key]).toBe(directResult[key]);
    }
  });

  it("includes all manager-only keys", () => {
    for (const key of MANAGER_ONLY_ITEM_KEYS) {
      expect(managerResult).toHaveProperty(key);
    }
  });

  it("salesPrice matches parity fixture", () => {
    expect(
      Math.abs(managerResult.salesPrice - expected.salesPrice)
    ).toBeLessThan(EPSILON);
  });

  it("totalProductionCogs matches parity fixture", () => {
    expect(
      Math.abs(managerResult.totalProductionCogs - expected.totalProductionCogs)
    ).toBeLessThan(EPSILON);
  });

  it("combinedGrossMarginBeforeCommission matches parity fixture", () => {
    expect(
      Math.abs(
        managerResult.combinedGrossMarginBeforeCommission -
          expected.combinedGrossMarginBeforeCommission
      )
    ).toBeLessThan(EPSILON);
  });

  it("netContributionOrderTotal matches parity fixture", () => {
    expect(
      Math.abs(
        managerResult.netContributionOrderTotal - expected.netContributionOrderTotal
      )
    ).toBeLessThan(EPSILON);
  });
});

// ---------------------------------------------------------------------------
// Staff Flat-Fee Quote: omits manager-only keys
// ---------------------------------------------------------------------------

describe("Staff flat-fee quote serialization boundary", () => {
  const staffResult = quoteFlatFeeStaff(FLAT_FEE_INPUT);

  it("includes customer-facing fields", () => {
    expect(staffResult).toHaveProperty("service");
    expect(staffResult).toHaveProperty("effectivePrice");
    expect(staffResult).toHaveProperty("status");
    expect(staffResult).toHaveProperty("billableQuantity");
    expect(staffResult).toHaveProperty("addOnTotal");
  });

  it.each(MANAGER_ONLY_FLAT_FEE_KEYS)(
    "omits manager-only key: %s",
    (key) => {
      expect(staffResult).not.toHaveProperty(key);
    }
  );

  it("has exactly 5 keys", () => {
    expect(Object.keys(staffResult)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Manager Flat-Fee Quote: preserves all existing engine behavior
// ---------------------------------------------------------------------------

describe("Manager flat-fee quote preserves full engine output", () => {
  const managerResult = quoteFlatFeeManager(FLAT_FEE_INPUT);
  const directResult = calculateFlatFeePrice(FLAT_FEE_INPUT);

  it("matches direct engine call exactly", () => {
    for (const key of Object.keys(directResult) as (keyof typeof directResult)[]) {
      expect(managerResult[key]).toBe(directResult[key]);
    }
  });

  it("includes all manager-only keys", () => {
    for (const key of MANAGER_ONLY_FLAT_FEE_KEYS) {
      expect(managerResult).toHaveProperty(key);
    }
  });

  it("engineCogs is positive", () => {
    expect(managerResult.engineCogs).toBeGreaterThan(0);
  });

  it("grossMargin is between 0 and 1", () => {
    expect(managerResult.grossMargin).toBeGreaterThan(0);
    expect(managerResult.grossMargin).toBeLessThan(1);
  });

  it("operatorOperatingCost is non-negative", () => {
    expect(managerResult.operatorOperatingCost).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Manager flat-fee with override: session-local override input preserved
// ---------------------------------------------------------------------------

describe("Manager flat-fee with manual override", () => {
  const overrideInput = {
    ...FLAT_FEE_INPUT,
    manualOverride: 10.0,
    extraOperatorMinutesPerShirt: 2,
    extraDesignerMinutesPerOrder: 15,
  };

  const managerResult = quoteFlatFeeManager(overrideInput);

  it("effectivePrice equals override", () => {
    expect(managerResult.effectivePrice).toBe(10.0);
  });

  it("status is Manual override", () => {
    expect(managerResult.status).toBe("Manual override");
  });

  it("extraOperatorLabor is positive with extra minutes", () => {
    expect(managerResult.extraOperatorLabor).toBeGreaterThan(0);
  });

  it("extraDesignerLabor is positive with extra minutes", () => {
    expect(managerResult.extraDesignerLabor).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Staff flat-fee with override: override reflected but no internal fields
// ---------------------------------------------------------------------------

describe("Staff flat-fee with manual override still omits internals", () => {
  const overrideInput = {
    ...FLAT_FEE_INPUT,
    manualOverride: 10.0,
    extraOperatorMinutesPerShirt: 2,
    extraDesignerMinutesPerOrder: 15,
  };

  const staffResult = quoteFlatFeeStaff(overrideInput);

  it("effectivePrice equals override", () => {
    expect(staffResult.effectivePrice).toBe(10.0);
  });

  it("status is Manual override", () => {
    expect(staffResult.status).toBe("Manual override");
  });

  it.each(MANAGER_ONLY_FLAT_FEE_KEYS)(
    "still omits manager-only key: %s",
    (key) => {
      expect(staffResult).not.toHaveProperty(key);
    }
  );
});
