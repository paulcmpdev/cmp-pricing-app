export interface EPDDRecord {
  UNIQUE_KEY: string;
  PRODUCT_TITLE: string;
  PRODUCT_DESCRIPTION: string;
  "STYLE#": string;
  CATEGORY_NAME: string;
  COLOR_NAME: string;
  SIZE: string;
  PIECE_PRICE: string;
  CASE_PRICE: string;
  INVENTORY_KEY: string;
  SIZE_INDEX: string;
  MILL: string;
  PRODUCT_STATUS: string;
  PRODUCT_IMAGE?: string;
  [key: string]: string | undefined;
}

export interface EPDDResult {
  products: Map<string, EPDDRecord>;
  malformedCount: number;
}

export interface DIPRecord {
  unique_key: string;
  catalog_no: string;
  color: string;
  size: string;
  total_qty: number;
  piece_price?: number;
  dozen_price?: number;
  case_price?: number;
  sale_price?: number;
  discontinued: boolean;
  discontinued_code?: string;
  warehouses: Array<{ warehouse: string; quantity: number }>;
}

export interface DIPResult {
  records: Map<string, DIPRecord>;
  malformedCount: number;
}

export interface JoinResult {
  styles: Array<{
    sourceStyleId: string;
    styleCode: string;
    brand?: string;
    name?: string;
    category?: string;
  }>;
  styleCount: number;
  variantCount: number;
  skippedCount: number;
}

export interface CompletenessManifest {
  vendor: string;
  styleCount: number;
  variantCount: number;
  skippedCount: number;
  sourceErrors?: number;
  complete?: boolean;
  contentHash: string;
  sourceHash?: string;
  sourceSha256?: string;
  source: string;
  snapshotTimestamp?: string;
  reasons?: Array<Record<string, unknown>>;
}

export function parseEPDD(
  source: NodeJS.ReadableStream | string,
  options?: { maxUniqueKeys?: number; shouldContinue?: () => boolean | Promise<boolean>; checkIntervalRows?: number }
): Promise<EPDDResult>;
export function parseDIP(
  source: NodeJS.ReadableStream | string,
  snapshotTime: Date,
  options?: {
    maxUniqueKeys?: number;
    maxWarehousesPerKey?: number;
    shouldContinue?: () => boolean | Promise<boolean>;
    checkIntervalRows?: number;
  }
): Promise<DIPResult>;
export function joinEPDDAndDIP(
  epddProducts: Map<string, EPDDRecord>,
  dipRecords: Map<string, DIPRecord>,
  callbacks?: {
    onStyle?: (style: any) => void | Promise<void>;
    onVariant?: (variant: any) => void | Promise<void>;
    shouldContinue?: () => boolean | Promise<boolean>;
    checkIntervalRows?: number;
    allowEpddPriceFallbackMissingDip?: boolean;
  }
): Promise<JoinResult>;

export function ingestSanMar(options: {
  epddSource: NodeJS.ReadableStream | string;
  dipSource: NodeJS.ReadableStream | string;
  snapshotTime?: Date;
  onStyle: (style: any) => void | Promise<void>;
  onVariant: (variant: any) => void | Promise<void>;
  shouldContinue?: () => boolean | Promise<boolean>;
  checkIntervalRows?: number;
  allowEpddPriceFallbackMissingDip?: boolean;
}): Promise<CompletenessManifest>;

export function ingestSanMarSDLN(options: {
  source: string;
  snapshotTime?: Date;
  onStyle: (style: any) => void | Promise<void>;
  onVariant: (variant: any) => void | Promise<void>;
  shouldContinue?: () => boolean | Promise<boolean>;
  checkIntervalRows?: number;
  maxUniqueKeys?: number;
  expectedSourceSha256: string;
}): Promise<CompletenessManifest>;
