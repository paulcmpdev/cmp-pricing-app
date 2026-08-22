/**
 * Pooled DTF Flat-Fee Engine
 *
 * Calculates incremental COGS for flat-fee add-on services by pooling
 * base + additional geometries on a gang sheet and computing the
 * incremental material cost over base-only.
 */
import "server-only";
import { d, roundUpToIncrement, ceilToWholeDollar } from "./money";
import { optimizePurchase } from "./dtf-optimizer";
import contract from "@/lib/fixtures/pricing-contract.json";

const SHEET_WIDTH = d(contract.dtfEngine.sheetWidthIn);
const SPACING = d(contract.dtfEngine.spacingIn);

const OPERATOR_OPERATING_COST = d(
  contract.dtfEngine.productionModes.find((m) => m.key === "average")!
    .operatingCostPerPlacement!
);
const OPERATOR_WAGE = d(contract.labor.operatorWagePerHour);
const DESIGNER_WAGE = d(contract.labor.designerWagePerHour);
const ENGINE_MARGIN = d(contract.pooledDtfPolicy.engineMargin);
const ROUNDING_INCREMENT = d(contract.pricingPolicy.roundingIncrement);

interface TransferGroup {
  widthIn: number;
  heightIn: number;
  totalCount: number;
}

export interface PooledFlatFeeInput {
  service: string;
  quantity: number;
}

export interface PooledFlatFeeOutput {
  service: string;
  quantity: number;
  uniqueGroups: number;
  pooledLength: number;
  pooledPurchase: number;
  baseLength: number;
  basePurchase: number;
  addOnPlacementsPerShirt: number;
  incrementalMaterialPerShirt: number;
  operatorOperatingCost: number;
  extraOperatorLabor: number;
  designerLabor: number;
  incrementalCogsPerShirt: number;
  t1Price: number;
  engineWhole: number;
}

function acrossFit(dim: number): number {
  const dimD = d(dim);
  if (dimD.gt(SHEET_WIDTH)) return 0;
  const remaining = SHEET_WIDTH.minus(dimD)
    .div(dimD.plus(SPACING))
    .floor()
    .toNumber();
  return 1 + remaining;
}

function orientationLengthCost(
  across: number,
  rowHeight: number,
  count: number
): number {
  if (across === 0) return Infinity;
  const rows = d(count).div(across).ceil().toNumber();
  return d(rows).times(d(rowHeight).plus(SPACING)).toNumber();
}

function bestOrientationForGroup(
  w: number,
  h: number,
  count: number
): { across: number; rowHeight: number } {
  const portraitAcross = acrossFit(w);
  const landscapeAcross = acrossFit(h);

  if (portraitAcross === 0 && landscapeAcross === 0) {
    throw new Error(`Transfer ${w}x${h} cannot fit on ${SHEET_WIDTH}" sheet`);
  }

  const portraitCost = orientationLengthCost(portraitAcross, h, count);
  const landscapeCost = orientationLengthCost(landscapeAcross, w, count);

  if (portraitCost <= landscapeCost) {
    return { across: portraitAcross, rowHeight: h };
  }
  return { across: landscapeAcross, rowHeight: w };
}

/**
 * Calculate total gang-sheet length for groups using (totalRows - 1) spacings.
 */
function calculateGangSheetLength(groups: TransferGroup[]): number {
  let totalHeight = d(0);
  let totalRows = 0;

  for (const group of groups) {
    const orient = bestOrientationForGroup(group.widthIn, group.heightIn, group.totalCount);
    const rows = d(group.totalCount).div(orient.across).ceil().toNumber();
    totalHeight = totalHeight.plus(d(orient.rowHeight).times(rows));
    totalRows += rows;
  }

  const spacingTotal = d(SPACING).times(Math.max(0, totalRows - 1));
  return totalHeight.plus(spacingTotal).toNumber();
}

function lookupGeometry(sizeKey: string) {
  const geo = contract.flatFeeGeometries.find((g) => g.key === sizeKey);
  if (!geo) throw new Error(`Unknown geometry: ${sizeKey}`);
  return geo;
}

function lookupServiceRow(service: string) {
  const row = contract.flatFeeServices.find((s) => s.service === service);
  if (!row) throw new Error(`Unknown flat-fee service: ${service}`);
  return row;
}

export function calculatePooledFlatFee(input: PooledFlatFeeInput): PooledFlatFeeOutput {
  const { service, quantity } = input;
  const policy = contract.pooledDtfPolicy;
  const serviceRow = lookupServiceRow(service);

  const compositions = policy.serviceCompositions as Record<
    string,
    Array<{ sizeKey: string; quantityPerShirt: number }>
  >;
  const components = compositions[service];
  if (!components) throw new Error(`No service composition for: ${service}`);

  const baseGeo = lookupGeometry(policy.baseComponent.sizeKey);

  // Build base-only group
  const baseGroup: TransferGroup = {
    widthIn: baseGeo.widthIn,
    heightIn: baseGeo.heightIn,
    totalCount: quantity * policy.baseComponent.quantityPerShirt,
  };

  // Build additional groups from service composition, merging same-geometry components
  const geoMap = new Map<string, TransferGroup>();
  for (const comp of components) {
    const geo = lookupGeometry(comp.sizeKey);
    const key = `${geo.widthIn}x${geo.heightIn}`;
    const existing = geoMap.get(key);
    if (existing) {
      existing.totalCount += quantity * comp.quantityPerShirt;
    } else {
      geoMap.set(key, {
        widthIn: geo.widthIn,
        heightIn: geo.heightIn,
        totalCount: quantity * comp.quantityPerShirt,
      });
    }
  }
  const additionalGroups: TransferGroup[] = Array.from(geoMap.values());

  // Total add-on placements per shirt
  const addOnPlacementsPerShirt = components.reduce(
    (sum, c) => sum + c.quantityPerShirt,
    0
  );

  // Unique groups = base + distinct additional geometries
  const uniqueGroups = 1 + additionalGroups.length;

  // Calculate lengths and purchases
  const pooledGroups = [baseGroup, ...additionalGroups];
  const pooledLength = calculateGangSheetLength(pooledGroups);
  const pooledPurchase = optimizePurchase(pooledLength);

  const baseLength = calculateGangSheetLength([baseGroup]);
  const basePurchase = optimizePurchase(baseLength);

  // Incremental material cost
  const incrementalMaterialPerShirt = d(
    Math.max(0, pooledPurchase - basePurchase)
  )
    .div(quantity)
    .toNumber();

  // Labor costs from contract service row
  const operatorOperatingCost = OPERATOR_OPERATING_COST.times(addOnPlacementsPerShirt).toNumber();
  const extraOperatorLabor = d(serviceRow.extraOperatorMinutesPerShirt)
    .div(60)
    .times(OPERATOR_WAGE)
    .toNumber();
  const designerLabor = d(serviceRow.extraDesignerMinutesPerOrder)
    .div(60)
    .times(DESIGNER_WAGE)
    .div(quantity)
    .toNumber();

  // Incremental COGS per shirt
  const incrementalCogsPerShirt = d(incrementalMaterialPerShirt)
    .plus(operatorOperatingCost)
    .plus(extraOperatorLabor)
    .plus(designerLabor)
    .toNumber();

  // T1 margin-loaded price: COGS / (1 - margin), rounded up to increment
  const rawT1 = d(incrementalCogsPerShirt).div(d(1).minus(ENGINE_MARGIN));
  const t1Price = roundUpToIncrement(rawT1, ROUNDING_INCREMENT).toNumber();

  // Whole-dollar recommendation
  const engineWhole = ceilToWholeDollar(t1Price);

  return {
    service,
    quantity,
    uniqueGroups,
    pooledLength,
    pooledPurchase,
    baseLength,
    basePurchase,
    addOnPlacementsPerShirt,
    incrementalMaterialPerShirt,
    operatorOperatingCost,
    extraOperatorLabor,
    designerLabor,
    incrementalCogsPerShirt,
    t1Price,
    engineWhole,
  };
}
