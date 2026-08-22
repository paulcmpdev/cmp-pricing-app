/**
 * Client-side types for API responses and catalog entries.
 * These match the server projections but contain no server-only imports.
 */

export interface CatalogEntry {
  category: string;
  sku: string;
  name: string;
}

export interface StaffItemQuote {
  productSell: number;
  decorationSell: number;
  salesPrice: number;
  salesOrderTotal: number;
  tierLabel: string;
  requiresManagerReview?: boolean;
}

export interface ManagerItemQuote extends StaffItemQuote {
  commissionReserve: number;
  totalDecorationCogs: number;
  totalProductionCogs: number;
  grossProfitBeforeCommission: number;
  netContributionAfterCommission: number;
  combinedGrossMarginBeforeCommission: number;
  contributionMarginAfterCommission: number;
  productionCogsOrderTotal: number;
  netContributionOrderTotal: number;
  vendorCatalog?: {
    vendor: "ss" | "sanmar";
    variantId: string;
    styleId: string;
    styleCode: string;
    color: string | null;
    size: string | null;
    unitCost: number;
    costBasis: string;
    sourceSyncAt: string | null;
  };
}

export interface VendorCatalogStyleSummary {
  id: string;
  vendor: "ss" | "sanmar";
  styleCode: string;
  brand: string | null;
  name: string | null;
  category: string | null;
  description: string | null;
  imageUrl: string | null;
  activeVariantCount: number;
  sourceSyncAt: string | null;
}

export interface VendorCatalogPublicVariant {
  id: string;
  styleId: string;
  vendor: "ss" | "sanmar";
  styleCode: string;
  color: string | null;
  size: string | null;
  sizeOrder: number | null;
  inventoryQty: number | null;
  imageUrl: string | null;
  discontinued: boolean;
  sourceSyncAt: string | null;
}

export interface StaffFlatFeeQuote {
  service: string;
  effectivePrice: number;
  status: string;
  billableQuantity: number;
  addOnTotal: number;
  requiresManagerReview?: boolean;
}

export interface ManagerFlatFeeQuote extends StaffFlatFeeQuote {
  engineCogs: number;
  enginePrice: number;
  policyFloor: number;
  grossMargin: number;
  operatorOperatingCost: number;
  extraOperatorLabor: number;
  extraDesignerLabor: number;
}
