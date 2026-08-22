export interface VendorStyle {
  sourceStyleId: string;
  styleCode: string;
  sourcePartNumber?: string;
  brand?: string;
  name?: string;
  category?: string;
  description?: string;
  imageUrl?: string;
}

export interface VendorVariant {
  sourceVariantId: string;
  sourceStyleId: string;
  styleCode: string;
  color?: string;
  size?: string;
  sizeOrder?: number;
  inventoryQty?: number;
  imageUrl?: string;
  discontinued: boolean;
  piecePrice?: number;
  dozenPrice?: number;
  casePrice?: number;
  salePrice?: number;
  customerPrice?: number;
  resolvedCost: number;
  costBasis: string;
}

export interface CompletenessManifest {
  vendor: string;
  styleCount: number;
  variantCount: number;
  skippedCount: number;
  contentHash: string;
  source: string;
  snapshotTimestamp?: string;
  complete?: boolean;
  sourceErrors?: number;
  reasons?: Array<Record<string, unknown>>;
  excludedStyleCount?: number;
  excludedStyleSamples?: Array<{
    styleId: string;
    confirmation: 'isolated_404';
  }>;
}

export interface SSSource {
  fetchStyles(): Promise<VendorStyle[]>;
  fetchProducts(styleIds: string[], options?: {
    shouldContinue?: () => boolean | Promise<boolean>;
  }): AsyncIterable<VendorVariant>;
  ingest(callbacks: {
    onStyle: (style: VendorStyle) => void | Promise<void>;
    onVariant: (variant: VendorVariant) => void | Promise<void>;
    shouldContinue?: () => boolean | Promise<boolean>;
  }): Promise<CompletenessManifest>;
}

export function createSSSource(options: {
  accountNumber: string;
  apiKey: string;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}): SSSource;
