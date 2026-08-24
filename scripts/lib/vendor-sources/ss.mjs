/**
 * S&S Activewear direct ingestion adapter.
 *
 * Fetches styles and products from the S&S API v2, normalizes them into
 * VendorStyle/VendorVariant contracts, and yields them as async iterables.
 *
 * Credentials are passed explicitly (never read from env here).
 * Fetch and sleep are injectable for testing.
 *
 * Strict validation: malformed styles and products fail closed (throw),
 * not silently skipped. Every product must belong to a requested style.
 */

import { createHash } from 'node:crypto';
import { createFixedOriginClient } from './http.mjs';
import { ErrorCategory, createSourceError } from './contracts.mjs';
import { abortableSleep } from './retry.mjs';

const SS_ORIGIN = 'https://api.ssactivewear.com';
const SS_API_BASE = '/v2';
const MAX_STYLE_IDS_PER_BATCH = 50;

/**
 * Validate a raw S&S style object strictly.
 * Malformed styles throw (fail closed), not return null.
 */
function validateStyle(raw) {
  if (raw == null || typeof raw !== 'object') {
    throw createSourceError(
      ErrorCategory.SCHEMA,
      `S&S style is not an object: ${typeof raw}`,
      { retryable: false }
    );
  }
  if (!raw.styleID && raw.styleID !== 0) {
    throw createSourceError(
      ErrorCategory.SCHEMA,
      `S&S style missing required field: styleID`,
      { retryable: false }
    );
  }
  if (!raw.styleName && raw.styleName !== 0) {
    throw createSourceError(
      ErrorCategory.SCHEMA,
      `S&S style missing required field: styleName (styleID=${raw.styleID})`,
      { retryable: false }
    );
  }
}

/**
 * Validate a raw S&S product object strictly.
 * Malformed products throw (fail closed), not return null.
 */
function validateProduct(raw) {
  if (raw == null || typeof raw !== 'object') {
    throw createSourceError(
      ErrorCategory.SCHEMA,
      `S&S product is not an object: ${typeof raw}`,
      { retryable: false }
    );
  }
  if (!raw.styleID && raw.styleID !== 0) {
    throw createSourceError(
      ErrorCategory.SCHEMA,
      `S&S product missing required field: styleID`,
      { retryable: false }
    );
  }
  if (!raw.sku) {
    throw createSourceError(
      ErrorCategory.SCHEMA,
      `S&S product missing required field: sku (styleID=${raw.styleID})`,
      { retryable: false }
    );
  }
  validateWarehouses(raw);
}

/**
 * Normalize a raw S&S style to VendorStyle contract.
 * Maps documented fields: styleID, styleName, brandName, title,
 * baseCategory (mapped to category), description, styleImage.
 */
function normalizeStyle(raw) {
  validateStyle(raw);

  return {
    sourceStyleId: String(raw.styleID),
    styleCode: String(raw.styleName),
    ...(raw.partNumber != null ? { sourcePartNumber: String(raw.partNumber) } : {}),
    brand: raw.brandName ? String(raw.brandName) : undefined,
    name: raw.title ? String(raw.title) : undefined,
    // S&S uses baseCategory for product categorization
    category: raw.baseCategory ? String(raw.baseCategory) : (raw.categoryName ? String(raw.categoryName) : undefined),
    description: raw.description ? String(raw.description) : undefined,
    imageUrl: raw.styleImage ? String(raw.styleImage) : undefined,
  };
}

/**
 * Normalize a raw S&S product to VendorVariant contract.
 * Maps documented fields: styleID, sku (partNumber equivalent),
 * colorName, sizeName, sizeOrder, qty (with warehouse detail awareness),
 * piecePrice, dozenPrice, casePrice, salePrice, customerPrice,
 * colorFrontImage/colorSideImage/colorBackImage, styleImage.
 *
 * Intentional omissions documented:
 * - partNumber: sku is used as sourceVariantId (partNumber is an alias)
 * - warehouse qty breakdown: validated for inventory fallback, not persisted
 */
function normalizeProduct(raw) {
  validateProduct(raw);

  const customerPrice = parsePrice(raw.customerPrice);
  const salePrice = parsePrice(raw.salePrice);
  const piecePrice = parsePrice(raw.piecePrice);
  const dozenPrice = parsePrice(raw.dozenPrice);
  const casePrice = parsePrice(raw.casePrice);
  const sizeOrder = raw.sizeOrder != null ? parseInt(String(raw.sizeOrder).replace(/[^0-9]/g, ''), 10) : undefined;

  // Resolve cost: always use piecePrice (the regular S&S price).
  // Ignore customerPrice/salePrice for resolved cost — they are
  // preserved as raw fields for audit/storage only.
  let resolvedCost = null;
  let costBasis = null;

  if (piecePrice != null && piecePrice > 0) {
    resolvedCost = piecePrice;
    costBasis = 'piecePrice';
  }

  const inventoryQty = resolveInventoryQty(raw);

  return {
    sourceVariantId: String(raw.sku),
    sourceStyleId: String(raw.styleID),
    styleCode: String(raw.styleName ?? raw.styleID),
    color: raw.colorName ? String(raw.colorName) : undefined,
    size: raw.sizeName ? String(raw.sizeName) : undefined,
    sizeOrder: Number.isFinite(sizeOrder) ? sizeOrder : undefined,
    inventoryQty,
    imageUrl: raw.colorFrontImage ? String(raw.colorFrontImage) :
              (raw.colorImage ? String(raw.colorImage) :
              (raw.styleImage ? String(raw.styleImage) : undefined)),
    discontinued: false, // S&S API returns active products only
    piecePrice,
    dozenPrice,
    casePrice,
    salePrice,
    customerPrice,
    resolvedCost,
    costBasis,
    // Mark whether this product has a resolvable price
    _hasPrice: resolvedCost != null && Number.isFinite(resolvedCost) && resolvedCost > 0,
  };
}

function validateWarehouses(raw) {
  if (raw.warehouses == null) return;
  if (!Array.isArray(raw.warehouses)) {
    throw createSourceError(
      ErrorCategory.SCHEMA,
      `S&S product warehouses is not an array (styleID=${raw.styleID}, sku=${raw.sku})`,
      { retryable: false }
    );
  }
  for (const [index, warehouse] of raw.warehouses.entries()) {
    if (warehouse == null || typeof warehouse !== 'object' || Array.isArray(warehouse)) {
      throw createSourceError(
        ErrorCategory.SCHEMA,
        `S&S product warehouse ${index} is not an object (styleID=${raw.styleID}, sku=${raw.sku})`,
        { retryable: false }
      );
    }
    if (warehouse.warehouseAbbr == null || warehouse.warehouseAbbr === '') {
      throw createSourceError(
        ErrorCategory.SCHEMA,
        `S&S product warehouse ${index} missing warehouseAbbr (styleID=${raw.styleID}, sku=${raw.sku})`,
        { retryable: false }
      );
    }
    const qty = Number(warehouse.qty);
    if (!Number.isFinite(qty) || qty < 0) {
      throw createSourceError(
        ErrorCategory.SCHEMA,
        `S&S product warehouse ${index} has invalid qty (styleID=${raw.styleID}, sku=${raw.sku})`,
        { retryable: false }
      );
    }
  }
}

function resolveInventoryQty(raw) {
  const aggregateQty = raw.qty != null ? Number(raw.qty) : undefined;
  if (Number.isFinite(aggregateQty) && aggregateQty >= 0) return aggregateQty;
  if (raw.warehouses == null) return undefined;
  return raw.warehouses.reduce((sum, warehouse) => sum + Number(warehouse.qty), 0);
}

function parsePrice(value) {
  if (value == null) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * Create an S&S source adapter.
 *
 * @param {Object} options
 * @param {string} options.accountNumber - S&S account number (Basic auth user)
 * @param {string} options.apiKey - S&S API key (Basic auth password)
 * @param {Function} [options.fetch] - Injectable fetch
 * @param {Function} [options.sleep] - Injectable sleep
 * @param {AbortSignal} [options.signal] - Abort signal
 * @returns {Object} Adapter with fetchStyles() and fetchProducts() methods
 */
export function createSSSource({ accountNumber, apiKey, fetch: fetchFn, sleep, signal }) {
  if (!accountNumber || !apiKey) {
    throw new Error('S&S credentials (accountNumber, apiKey) are required');
  }

  const authHeader = 'Basic ' + Buffer.from(`${accountNumber}:${apiKey}`).toString('base64');

  const client = createFixedOriginClient({
    origin: SS_ORIGIN,
    defaultHeaders: {
      'Authorization': authHeader,
      'Accept': 'application/json',
    },
    fetch: fetchFn,
    sleep,
    signal,
  });

  /**
   * Fetch all styles from S&S API.
   * Returns normalized VendorStyle array.
   * Malformed styles throw — fail closed.
   */
  async function fetchStyles() {
    const { data } = await client.get(`${SS_API_BASE}/styles/`);

    if (!Array.isArray(data)) {
      throw createSourceError(
        ErrorCategory.SCHEMA,
        'S&S /styles/ response is not an array',
        { retryable: false }
      );
    }

    return data.map(normalizeStyle);
  }

  /**
   * Fetch products for a batch of style IDs.
   * Yields VendorVariant objects via async iteration.
   * Enforces: every product must belong to a requested style.
   * Requested styles with zero products are tracked for completeness.
   *
   * @param {string[]} styleIds - All style IDs to fetch
   * @param {Object} [options]
   * @param {Function} [options.shouldContinue] - Cancellation check callback
   * @yields {VendorVariant}
   */
  async function* fetchProducts(styleIds, options = {}) {
    for await (const event of fetchProductEvents(styleIds, options)) {
      if (event.variant) yield event.variant;
    }
  }

  async function* fetchProductEvents(styleIds, options = {}) {
    const { shouldContinue } = options;
    const batches = chunkArray(styleIds, MAX_STYLE_IDS_PER_BATCH);
    const seenSkus = new Map();

    for (const batch of batches) {
      if (signal?.aborted) {
        throw createSourceError(ErrorCategory.CANCELED, 'S&S product fetch canceled');
      }

      if (shouldContinue && !(await shouldContinue())) {
        throw createSourceError(ErrorCategory.CANCELED, 'S&S product fetch canceled by orchestrator');
      }

      const batchSet = new Set(batch.map(String));

      const { data, headers } = await client.get(`${SS_API_BASE}/products/`, {
        query: { styleid: batch.join(',') },
      });

      if (!Array.isArray(data)) {
        throw createSourceError(
          ErrorCategory.SCHEMA,
          `S&S /products/ response is not an array for styleids ${batch.join(',')}`,
          { retryable: false }
        );
      }

      if (data.length === 0) {
        yield {
          type: 'emptyBatch',
          requestedStyleIds: batch.map(String),
        };
      }

      for (const product of data) {
        const variant = normalizeProduct(product);

        // Every returned product must belong to a requested style
        if (!batchSet.has(String(variant.sourceStyleId))) {
          throw createSourceError(
            ErrorCategory.VALIDATION,
            `S&S returned product for unrequested style: ${variant.sourceStyleId} ` +
            `(requested: ${batch.join(',')})`,
            { retryable: false }
          );
        }

        const sku = variant.sourceVariantId;
        const identity = productIdentity(variant);
        const previous = seenSkus.get(sku);
        if (previous) {
          if (previous.identity !== identity) {
            throw createSourceError(
              ErrorCategory.VALIDATION,
              `S&S duplicate sku with conflicting identity: ${sku}`,
              { retryable: false }
            );
          }
          throw createSourceError(
            ErrorCategory.VALIDATION,
            `S&S duplicate product emission across batches: ${sku}`,
            { retryable: false }
          );
        }
        seenSkus.set(sku, { identity });

        if (variant._hasPrice) {
          // Remove internal marker before yielding
          const { _hasPrice, ...clean } = variant;
          yield {
            type: 'product',
            sourceStyleId: clean.sourceStyleId,
            hasUsablePrice: true,
            variant: clean,
          };
        } else {
          yield {
            type: 'product',
            sourceStyleId: variant.sourceStyleId,
            hasUsablePrice: false,
            variant: null,
          };
        }
      }

      // Respect rate limiting
      const remaining = headers.rateLimitRemaining;
      if (remaining != null && Number(remaining) <= 2) {
        await sleepWithAbort(1000, { sleep, signal });
      }
    }
  }

  /**
   * Full ingestion: fetch styles, then stream products.
   * Returns completeness manifest and yields data via callback.
   *
   * @param {Object} callbacks
   * @param {Function} callbacks.onStyle - Called with each VendorStyle
   * @param {Function} callbacks.onVariant - Called with each VendorVariant
   * @param {Function} [callbacks.shouldContinue] - Cancellation check
   * @returns {Promise<CompletenessManifest>}
   */
  async function ingest({ onStyle, onVariant, shouldContinue }) {
    const hash = createHash('sha256');
    let styleCount = 0;
    let variantCount = 0;
    let skippedCount = 0;

    if (shouldContinue && !(await shouldContinue())) {
      throw createSourceError(ErrorCategory.CANCELED, 'S&S ingestion canceled before style fetch');
    }

    const styles = await fetchStyles();
    const styleIds = [];
    const rawProductsPerStyle = new Map();
    const usableProductsPerStyle = new Map();

    for (const style of styles) {
      hash.update(JSON.stringify(style) + '\n');
      styleCount++;
      styleIds.push(style.sourceStyleId);
      rawProductsPerStyle.set(style.sourceStyleId, 0);
      usableProductsPerStyle.set(style.sourceStyleId, 0);
      await onStyle(style);
    }

    if (shouldContinue && !(await shouldContinue())) {
      throw createSourceError(ErrorCategory.CANCELED, 'S&S ingestion canceled after style fetch');
    }

    for await (const event of fetchProductEvents(styleIds, { shouldContinue })) {
      if (event.type === 'emptyBatch') {
        continue;
      }

      rawProductsPerStyle.set(event.sourceStyleId,
        (rawProductsPerStyle.get(event.sourceStyleId) || 0) + 1);

      if (!event.hasUsablePrice || !event.variant) {
        skippedCount++;
        continue;
      }

      const variant = event.variant;
      if (!isValidVariant(variant)) {
        skippedCount++;
        continue;
      }
      hash.update(JSON.stringify(variant) + '\n');
      variantCount++;
      usableProductsPerStyle.set(variant.sourceStyleId,
        (usableProductsPerStyle.get(variant.sourceStyleId) || 0) + 1);
      await onVariant(variant);
    }

    const reasons = completenessReasons({ rawProductsPerStyle, usableProductsPerStyle });

    return {
      vendor: 'ss',
      styleCount,
      variantCount,
      skippedCount,
      contentHash: hash.digest('hex'),
      source: 'ss-api',
      complete: reasons.length === 0,
      sourceErrors: reasons.length,
      reasons,
    };
  }

  return { fetchStyles, fetchProducts, ingest };
}

function productIdentity(variant) {
  return JSON.stringify({
    sourceStyleId: variant.sourceStyleId,
    styleCode: variant.styleCode,
    color: variant.color ?? null,
    size: variant.size ?? null,
    sizeOrder: variant.sizeOrder ?? null,
  });
}

function completenessReasons({ rawProductsPerStyle, usableProductsPerStyle }) {
  const reasons = [];
  for (const styleId of rawProductsPerStyle.keys()) {
    const rawCount = rawProductsPerStyle.get(styleId) || 0;
    const usableCount = usableProductsPerStyle.get(styleId) || 0;
    if (rawCount === 0 || usableCount !== rawCount) {
      reasons.push({
        code: 'ss_style_incomplete',
        styleId,
        rawProductCount: rawCount,
        usableVariantCount: usableCount,
      });
    }
  }
  return reasons;
}

async function sleepWithAbort(ms, { sleep, signal } = {}) {
  if (!sleep) {
    await abortableSleep(ms, { signal });
    return;
  }
  if (signal?.aborted) {
    throw createSourceError(ErrorCategory.CANCELED, 'S&S rate-limit sleep aborted');
  }
  if (!signal) {
    await sleep(ms);
    return;
  }

  let removeAbortListener;
  const abortPromise = new Promise((_, reject) => {
    const onAbort = () => reject(createSourceError(ErrorCategory.CANCELED, 'S&S rate-limit sleep aborted'));
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    await Promise.race([sleep(ms), abortPromise]);
  } finally {
    removeAbortListener?.();
  }
}

function isValidVariant(variant) {
  return (
    variant.resolvedCost != null &&
    Number.isFinite(variant.resolvedCost) &&
    variant.resolvedCost > 0 &&
    variant.sourceVariantId &&
    variant.sourceStyleId
  );
}

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
