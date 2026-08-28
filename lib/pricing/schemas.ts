import { z } from "zod";

export const ProductSchema = z.object({
  category: z.string(),
  sku: z.string(),
  name: z.string(),
  bulkPrice: z.number().nullable(),
  onlineShopPrice: z.number(),
  productCost: z.number(),
});

export type Product = z.infer<typeof ProductSchema>;

export const ProductCatalogSchema = z.object({
  products: z.array(ProductSchema),
});

export const ItemPriceInputSchema = z.object({
  productCost: z.number().min(0),
  quantity: z.number().int().min(1),
  productCostMultiplier: z.number().default(2),
  // No default here: the lane must be resolved by the caller (either the
  // client's requested lane, or the first active lane of the active pricing
  // config) — never hard-coded, since which lane is "first" is admin-defined.
  tierPriceLane: z.string().min(1).max(20),
});

export type ItemPriceInput = z.infer<typeof ItemPriceInputSchema>;

export const ItemPriceOutputSchema = z.object({
  productSell: z.number(),
  decorationSell: z.number(),
  salesPrice: z.number(),
  commissionReserve: z.number(),
  totalDecorationCogs: z.number(),
  totalProductionCogs: z.number(),
  grossProfitBeforeCommission: z.number(),
  netContributionAfterCommission: z.number(),
  combinedGrossMarginBeforeCommission: z.number(),
  contributionMarginAfterCommission: z.number(),
  salesOrderTotal: z.number(),
  productionCogsOrderTotal: z.number(),
  netContributionOrderTotal: z.number(),
  tierLabel: z.string(),
});

export type ItemPriceOutput = z.infer<typeof ItemPriceOutputSchema>;

export const FlatFeeInputSchema = z.object({
  service: z.string(),
  orderQuantity: z.number().int().min(1),
  extraOperatorMinutesPerShirt: z.number().min(0).default(0),
  extraDesignerMinutesPerOrder: z.number().min(0).default(0),
  manualOverride: z.number().min(0).nullable().default(null),
});

export type FlatFeeInput = z.infer<typeof FlatFeeInputSchema>;

export const FlatFeeOutputSchema = z.object({
  service: z.string(),
  engineCogs: z.number(),
  enginePrice: z.number(),
  policyFloor: z.number(),
  effectivePrice: z.number(),
  grossMargin: z.number(),
  status: z.string(),
  billableQuantity: z.number(),
  addOnTotal: z.number(),
  operatorOperatingCost: z.number(),
  extraOperatorLabor: z.number(),
  extraDesignerLabor: z.number(),
});

export type FlatFeeOutput = z.infer<typeof FlatFeeOutputSchema>;

export const SheetOptionSchema = z.object({
  label: z.string(),
  lengthIn: z.number(),
  publishedPrice: z.number(),
  usableCapacityAtCapturedSize: z.number(),
  effectiveSheetCost: z.number(),
});

export const FlatFeeGeometrySchema = z.object({
  key: z.string(),
  name: z.string(),
  category: z.string(),
  widthIn: z.number(),
  heightIn: z.number(),
  areaSqIn: z.number(),
  active: z.boolean(),
});

export type FlatFeeGeometry = z.infer<typeof FlatFeeGeometrySchema>;

export const TierSchema = z.object({
  tier: z.string(),
  minQty: z.number(),
  maxQty: z.number(),
  activeTotalDtfCogs: z.number(),
  prices: z.object({
    T1: z.number(),
    T2: z.number(),
    T3: z.number(),
    T4: z.number(),
  }),
  pricingBasis: z.string(),
  costingQtyWorstCase: z.number(),
});

export type Tier = z.infer<typeof TierSchema>;
