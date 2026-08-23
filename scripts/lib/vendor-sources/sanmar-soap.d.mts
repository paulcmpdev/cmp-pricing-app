export interface SanMarSoapStyle {
  sourceStyleId: string;
  styleCode: string;
  brand?: string;
  name?: string;
  category?: string;
  description?: string;
  imageUrl?: string;
}

export interface SanMarSoapVariant {
  sourceVariantId: string;
  sourceStyleId: string;
  styleCode: string;
  color: string;
  size: string;
  sizeOrder?: number;
  inventoryQty?: number;
  imageUrl?: string;
  discontinued: boolean;
  piecePrice: number;
  dozenPrice?: number;
  casePrice?: number;
  salePrice?: number;
  customerPrice?: number;
  resolvedCost: number;
  costBasis: 'piecePrice';
}

export interface SanMarSoapManifest {
  vendor: 'sanmar';
  styleCount: number;
  variantCount: number;
  skippedCount: 0;
  sourceErrors: 0;
  complete: true;
  contentHash: string;
  source: 'sanmar-soap-style-delta';
  snapshotTimestamp: string;
  bootstrapStyleCount: number;
  modifiedStyleCount: number;
  requestedStyleCount: number;
  requestCount: number;
  excludedStyleCount: number;
  excludedStyleSamples: string[];
  reasons: [];
}

export function parseSanMarProductInfoResponse(
  xml: string,
  options?: { styleId?: string; brand?: string; maxResponseBytes?: number }
): {
  styles: SanMarSoapStyle[];
  variants: SanMarSoapVariant[];
  message?: string;
  responseBytes: number;
};

export function parseSanMarDateModifiedResponse(
  xml: string,
  options?: { maxResponseBytes?: number }
): string[];

export function parseSanMarProductLookupResponse(
  xml: string,
  options: { styleId: string; maxResponseBytes?: number }
): { found: boolean };

export function createSanMarSoapSource(options: {
  customerNumber: string;
  username: string;
  password: string;
  styleIds: string[];
  since?: string | Date | null;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  requestDelayMs?: number;
  now?: () => Date | string | number;
  watermarkOverlapMs?: number;
}): {
  fetchModifiedStyleIds(): Promise<string[]>;
  fetchStyle(styleId: string): Promise<{
    styles: SanMarSoapStyle[];
    variants: SanMarSoapVariant[];
    message?: string;
    responseBytes: number;
    confirmedUnavailable?: true;
  }>;
  ingest(callbacks: {
    onStyle: (style: SanMarSoapStyle) => void | Promise<void>;
    onVariant: (variant: SanMarSoapVariant) => void | Promise<void>;
    shouldContinue?: () => boolean | Promise<boolean>;
  }): Promise<SanMarSoapManifest>;
};

export interface SanMarDeltaStyleResult {
  styleId: string;
  action: 'replace' | 'remove';
  styles: SanMarSoapStyle[];
  variants: SanMarSoapVariant[];
}

export interface SanMarDeltaDiscovery {
  snapshotTimestamp: string;
  modifiedStyleIds: string[];
  results: SanMarDeltaStyleResult[];
  requestCount: number;
  excludedStyleIds: string[];
  excludedStyleCount: number;
}

export function createSanMarDeltaSource(options: {
  customerNumber: string;
  username: string;
  password: string;
  since?: string | Date | null;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  requestDelayMs?: number;
  now?: () => Date | string | number;
  watermarkOverlapMs?: number;
}): {
  fetchModifiedStyleIds(): Promise<string[]>;
  fetchStyle(styleId: string): Promise<{
    styles: SanMarSoapStyle[];
    variants: SanMarSoapVariant[];
    message?: string;
    responseBytes: number;
    confirmedUnavailable?: true;
  }>;
  discover(options?: {
    shouldContinue?: () => boolean | Promise<boolean>;
  }): Promise<SanMarDeltaDiscovery>;
};
