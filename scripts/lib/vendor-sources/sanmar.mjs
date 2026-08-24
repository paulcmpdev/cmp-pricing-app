/**
 * SanMar EPDD + DIP file parser/adapter.
 *
 * Phase 1: Parses local pre-delivered EPDD (CSV) and DIP (pipe-delimited) files.
 * Secure file delivery transport is deferred. SanMar documents SFTP/SSH at
 * ftp.sanmar.com:2200; FTPS/TLS is unsupported. This adapter only handles
 * already-delivered local files.
 *
 * EPDD parsing uses csv-parse for production-grade quote-encapsulated CSV
 * handling, including multiline quoted fields.
 *
 * Join strategy: DIP rows keyed by Unique_key are joined to EPDD product data.
 * The EPDD index (Map<UNIQUE_KEY, record>) is bounded by MAX_EPDD_UNIQUE_KEYS.
 * The DIP aggregate map (Map<Unique_key, record>) is bounded by
 * MAX_DIP_UNIQUE_KEYS, and the warehouse list on each DIP record is bounded by
 * MAX_WAREHOUSES_PER_DIP_KEY. Output styles/variants are streamed to callbacks;
 * no final variant array is materialized.
 *
 * Warehouse inventory is aggregated deterministically (sum by unique_key).
 * Zero inventory is preserved. Sale price is preserved for audit only;
 * CMP's SanMar resolved cost is always valid positive case_price.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { parse as csvParse } from 'csv-parse';
import { createInterface } from 'node:readline';
import { ErrorCategory, createSourceError } from './contracts.mjs';

const MAX_EPDD_UNIQUE_KEYS = 250_000;
const MAX_DIP_UNIQUE_KEYS = 250_000;
const MAX_WAREHOUSES_PER_DIP_KEY = 32;
const DEFAULT_CHECK_INTERVAL_ROWS = 1000;

// Required EPDD headers from the official Feb 2026 guide (case-insensitive match)
const REQUIRED_EPDD_HEADERS = [
  'UNIQUE_KEY', 'PRODUCT_TITLE', 'PRODUCT_DESCRIPTION', 'STYLE#',
  'CATEGORY_NAME', 'COLOR_NAME', 'SIZE', 'PIECE_PRICE', 'CASE_PRICE',
  'INVENTORY_KEY', 'SIZE_INDEX', 'MILL', 'PRODUCT_STATUS', 'PRODUCT_IMAGE',
];

// Required DIP headers from the official Feb 2026 guide (case-insensitive match)
const REQUIRED_DIP_HEADERS = [
  'inventory_key', 'size_index', 'catalog_no', 'catalog_color', 'size',
  'whse_no', 'quantity', 'piece_price', 'dozens_price', 'case_price',
  'case_size', 'each_sale_price', 'sale_start_datetime',
  'sale_end_datetime', 'unique_key', 'discontinued_code',
];

const EPDD_HEADER_ALIASES = new Map([
  ['CATALOG_NO', 'STYLE#'],
  ['STYLE', 'STYLE#'],
  ['BRAND_NAME', 'MILL'],
  ['CATEGORY', 'CATEGORY_NAME'],
  ['DESCRIPTION', 'PRODUCT_DESCRIPTION'],
  ['IMAGE_URL', 'PRODUCT_IMAGE'],
  ['PRODUCT_IMAGE_URL', 'PRODUCT_IMAGE'],
  ['PRODUCT_IMAGE_FRONT', 'PRODUCT_IMAGE'],
  ['FRONT_MODEL', 'PRODUCT_IMAGE'],
  ['FRONT_MODEL_IMAGE', 'PRODUCT_IMAGE'],
]);

const DIP_HEADER_ALIASES = new Map([
  ['color', 'catalog_color'],
  ['warehouse', 'whse_no'],
  ['sale_price', 'each_sale_price'],
  ['sale_start_date', 'sale_start_datetime'],
  ['sale_end_date', 'sale_end_datetime'],
]);

/**
 * Parse an EPDD CSV file into a Map of product records keyed by UNIQUE_KEY.
 *
 * Uses csv-parse for production-grade RFC 4180 CSV parsing with proper
 * multiline quoted field support.
 *
 * EPDD index memory: bounded at O(unique products). With ~150k SanMar
 * products at ~200 bytes per record, this is ~30MB — acceptable for a
 * worker process. The index is required for DIP join.
 *
 * @param {ReadableStream|string} source - File path or readable stream
 * @returns {Promise<Map<string, Object>>} Map of UNIQUE_KEY -> product record
 */
export async function parseEPDD(source, options = {}) {
  const maxUniqueKeys = options.maxUniqueKeys ?? MAX_EPDD_UNIQUE_KEYS;
  const shouldContinue = options.shouldContinue;
  const checkIntervalRows = normalizeCheckInterval(options.checkIntervalRows);
  const input = typeof source === 'string'
    ? createReadStream(source)
    : source;

  const parser = input.pipe(csvParse({
    columns: (headers) => {
      return headers.map(canonicalizeEPDDHeader);
    },
    skip_empty_lines: true,
    relax_column_count_less: false,
    relax_column_count_more: false,
    trim: true,
    cast: false,
  }));

  const products = new Map();
  let lineNum = 1; // header is line 1
  let malformedCount = 0;
  let headersValidated = false;

  try {
    for await (const record of parser) {
      lineNum++;
      if (shouldContinue && lineNum % checkIntervalRows === 0 && !(await shouldContinue())) {
        throw createSourceError(ErrorCategory.CANCELED, 'SanMar ingestion canceled during EPDD parse');
      }

      // Validate headers on first record
      if (!headersValidated) {
        const actualHeaders = Object.keys(record);
        validateHeaders(actualHeaders, REQUIRED_EPDD_HEADERS, 'EPDD', 1);
        headersValidated = true;
      }

      const uniqueKey = record.UNIQUE_KEY;
      if (!uniqueKey) {
        malformedCount++;
        continue;
      }

      const catalogNo = record['STYLE#'];
      const colorName = record.COLOR_NAME;
      const size = record.SIZE;
      const piecePrice = record.PIECE_PRICE;
      const casePrice = record.CASE_PRICE;

      if (!catalogNo) {
        malformedCount++;
        continue;
      }

      // Check for duplicate-conflicting identities
      if (products.has(uniqueKey)) {
        const existing = products.get(uniqueKey);
        if (existing['STYLE#'] !== catalogNo ||
            existing.COLOR_NAME !== colorName ||
            existing.SIZE !== size ||
            !pricesEqual(existing.PIECE_PRICE, piecePrice) ||
            !pricesEqual(existing.CASE_PRICE, casePrice)) {
          throw createSourceError(
            ErrorCategory.VALIDATION,
            `EPDD duplicate unique_key "${uniqueKey}" with conflicting identity at line ${lineNum}: ` +
            `existing=${existing['STYLE#']}/${existing.COLOR_NAME}/${existing.SIZE} ` +
            `vs new=${catalogNo}/${colorName}/${size}`,
            { retryable: false }
          );
        }
        existing.CATEGORY_NAME = mergeCategoryNames(existing.CATEGORY_NAME, record.CATEGORY_NAME);
        continue;
      }

      if (products.size >= maxUniqueKeys) {
        throw createSourceError(
          ErrorCategory.VALIDATION,
          `EPDD unique key cap exceeded (${maxUniqueKeys})`,
          { retryable: false }
        );
      }

      products.set(uniqueKey, record);
    }
  } catch (error) {
    // csv-parse errors for malformed CSV
    if (error.category) throw error;
    if (error.code === 'CSV_RECORD_INCONSISTENT_COLUMNS' ||
        error.code === 'CSV_RECORD_INCONSISTENT_FIELDS_LENGTH' ||
        error.code === 'CSV_QUOTE_NOT_CLOSED') {
      malformedCount++;
      throw createSourceError(
        ErrorCategory.PARSE,
        `EPDD CSV parse error at line ${lineNum}: ${error.message}`,
        { retryable: false }
      );
    }
    throw error;
  }

  if (!headersValidated) {
    throw createSourceError(ErrorCategory.PARSE, 'EPDD file is empty', { retryable: false });
  }

  if (malformedCount > 0 && products.size === 0) {
    throw createSourceError(
      ErrorCategory.VALIDATION,
      `EPDD: all ${malformedCount} data rows were malformed`,
      { retryable: false }
    );
  }

  return { products, malformedCount };
}

/**
 * Parse a DIP pipe-delimited file into aggregated inventory/pricing records.
 *
 * DIP identity: inventory_key + size_index = unique_key.
 * Warehouse inventory is aggregated by unique_key (sum quantities).
 * Pricing uses the first row's prices per unique_key (deterministic by sort).
 *
 * DIP is streamed line-by-line via readline (not materialized).
 *
 * @param {ReadableStream|string} source - File path or readable stream
 * @param {Date} snapshotTime - Current time for sale date evaluation
 * @returns {Promise<Map<string, Object>>} Map of unique_key -> aggregated record
 */
export async function parseDIP(source, snapshotTime, options = {}) {
  if (!(snapshotTime instanceof Date) || isNaN(snapshotTime.getTime())) {
    throw new Error('snapshotTime must be a valid Date');
  }
  const maxUniqueKeys = options.maxUniqueKeys ?? MAX_DIP_UNIQUE_KEYS;
  const maxWarehousesPerKey = options.maxWarehousesPerKey ?? MAX_WAREHOUSES_PER_DIP_KEY;
  const shouldContinue = options.shouldContinue;
  const checkIntervalRows = normalizeCheckInterval(options.checkIntervalRows);

  const lines = typeof source === 'string'
    ? createInterface({ input: createReadStream(source), crlfDelay: Infinity })
    : createInterface({ input: source, crlfDelay: Infinity });

  let headers = null;
  let headerIndexMap = null;
  const aggregated = new Map();
  let lineNum = 0;
  let malformedCount = 0;

  for await (const rawLine of lines) {
    lineNum++;
    if (shouldContinue && lineNum % checkIntervalRows === 0 && !(await shouldContinue())) {
      throw createSourceError(ErrorCategory.CANCELED, 'SanMar ingestion canceled during DIP parse');
    }
    const line = rawLine.trim();
    if (!line) continue;

    if (!headers) {
      headers = line.split('|').map(canonicalizeDIPHeader);
      validateHeaders(headers, REQUIRED_DIP_HEADERS, 'DIP', lineNum);
      // Build index map for canonical access
      headerIndexMap = new Map();
      for (let i = 0; i < headers.length; i++) {
        headerIndexMap.set(headers[i], i);
      }
      continue;
    }

    const values = line.split('|');
    if (values.length !== headers.length) {
      malformedCount++;
      continue;
    }

    const record = {};
    for (let i = 0; i < headers.length; i++) {
      record[headers[i]] = values[i]?.trim() ?? '';
    }

    const uniqueKey = record.unique_key;
    if (!uniqueKey) {
      malformedCount++;
      continue;
    }

    const warehouseQty = parseStrictNonnegativeInteger(record.quantity);
    const piecePriceResult = parseOptionalStrictNonnegativeFloat(record.piece_price);
    const casePriceResult = parseOptionalStrictNonnegativeFloat(record.case_price);
    const dozenPriceResult = parseOptionalStrictNonnegativeFloat(record.dozens_price);
    const salePriceResult = parseOptionalStrictNonnegativeFloat(record.each_sale_price);
    if (warehouseQty == null ||
        !piecePriceResult.valid ||
        !casePriceResult.valid ||
        !dozenPriceResult.valid ||
        !salePriceResult.valid) {
      malformedCount++;
      continue;
    }
    const qty = warehouseQty;
    const piecePrice = piecePriceResult.value;
    const casePrice = casePriceResult.value;
    const dozenPrice = dozenPriceResult.value;
    const salePrice = salePriceResult.value;

    if (aggregated.has(uniqueKey)) {
      const existing = aggregated.get(uniqueKey);

      // Check for conflicting identity
      if (existing.catalog_no !== record.catalog_no ||
          existing.color !== record.catalog_color ||
          existing.size !== record.size ||
          existing.piece_price !== piecePrice ||
          existing.case_price !== casePrice ||
          existing.dozen_price !== dozenPrice ||
          existing.each_sale_price !== salePrice) {
        throw createSourceError(
          ErrorCategory.VALIDATION,
          `DIP duplicate unique_key "${uniqueKey}" with conflicting identity at line ${lineNum}`,
          { retryable: false }
        );
      }

      // Aggregate inventory across warehouses
      existing.total_qty += qty;
      const warehouse = record.whse_no;
      const warehouseEntry = existing.warehouseMap.get(warehouse);
      if (warehouseEntry) {
        warehouseEntry.quantity += qty;
      } else {
        if (existing.warehouseMap.size >= maxWarehousesPerKey) {
          throw createSourceError(
            ErrorCategory.VALIDATION,
            `DIP warehouse cap exceeded for unique_key "${uniqueKey}" (${maxWarehousesPerKey})`,
            { retryable: false }
          );
        }
        const nextWarehouse = { warehouse, quantity: qty };
        existing.warehouseMap.set(warehouse, nextWarehouse);
        existing.warehouses.push(nextWarehouse);
      }
    } else {
      if (aggregated.size >= maxUniqueKeys) {
        throw createSourceError(
          ErrorCategory.VALIDATION,
          `DIP unique key cap exceeded (${maxUniqueKeys})`,
          { retryable: false }
        );
      }
      const saleActive = isSaleActive(record.sale_start_datetime, record.sale_end_datetime, snapshotTime);
      const discontinuedCode = record.discontinued_code?.trim();
      const warehouse = record.whse_no;
      const firstWarehouse = { warehouse, quantity: qty };

      aggregated.set(uniqueKey, {
        unique_key: uniqueKey,
        catalog_no: record.catalog_no,
        color: record.catalog_color,
        size: record.size,
        total_qty: qty,
        piece_price: piecePrice,
        dozen_price: dozenPrice,
        case_price: casePrice,
        sale_price: saleActive && salePrice != null && salePrice > 0 ? salePrice : undefined,
        each_sale_price: salePrice,
        discontinued: isDiscontinued(discontinuedCode),
        discontinued_code: discontinuedCode || undefined,
        warehouses: [firstWarehouse],
        warehouseMap: new Map([[warehouse, firstWarehouse]]),
      });
    }
  }

  if (!headers) {
    throw createSourceError(ErrorCategory.PARSE, 'DIP file is empty', { retryable: false });
  }

  if (malformedCount > 0 && aggregated.size === 0) {
    throw createSourceError(
      ErrorCategory.VALIDATION,
      `DIP: all ${malformedCount} data rows were malformed`,
      { retryable: false }
    );
  }

  return { records: aggregated, malformedCount };
}

/**
 * Join EPDD product data with DIP inventory/pricing to produce normalized variants.
 * Streams output via callbacks rather than materializing full variants array.
 *
 * @param {Map<string, Object>} epddProducts - From parseEPDD()
 * @param {Map<string, Object>} dipRecords - From parseDIP()
 * @param {Object} [callbacks]
 * @param {Function} [callbacks.onStyle] - Called with each VendorStyle
 * @param {Function} [callbacks.onVariant] - Called with each VendorVariant
 * @returns {Object} { styleCount, variantCount, skippedCount }
 */
export async function joinEPDDAndDIP(epddProducts, dipRecords, callbacks) {
  const stylesMap = new Map();
  let variantCount = 0;
  let skippedCount = 0;
  let missingDipCount = 0;
  let processedCount = 0;
  const missingDipSamples = [];
  const allowEpddPriceFallbackMissingDip = callbacks?.allowEpddPriceFallbackMissingDip === true;
  const shouldContinue = callbacks?.shouldContinue;
  const checkIntervalRows = normalizeCheckInterval(callbacks?.checkIntervalRows);

  // Process all EPDD products, enriching with DIP data when available
  for (const [uniqueKey, epdd] of epddProducts) {
    processedCount++;
    if (shouldContinue && processedCount % checkIntervalRows === 0 && !(await shouldContinue())) {
      throw createSourceError(ErrorCategory.CANCELED, 'SanMar ingestion canceled during EPDD/DIP join');
    }

    const dip = dipRecords.get(uniqueKey);

    const catalogNo = epdd['STYLE#'];
    if (!catalogNo) {
      skippedCount++;
      continue;
    }

    // Build/update style
    if (!stylesMap.has(catalogNo)) {
      const style = {
        sourceStyleId: catalogNo,
        styleCode: catalogNo,
        brand: epdd.MILL || undefined,
        name: epdd.PRODUCT_TITLE || undefined,
        category: epdd.CATEGORY_NAME || undefined,
        description: epdd.PRODUCT_DESCRIPTION || undefined,
        imageUrl: epdd.PRODUCT_IMAGE || undefined,
      };
      stylesMap.set(catalogNo, style);
      if (callbacks?.onStyle) await callbacks.onStyle(style);
    }

    // Resolve pricing from DIP. EPDD fallback is diagnostic-only and disabled
    // by default because it has unknown inventory and is incomplete.
    let piecePrice, casePrice, salePrice, resolvedCost, costBasis;
    const discontinued = dip?.discontinued ?? false;

    if (dip) {
      piecePrice = dip.piece_price;
      casePrice = dip.case_price;
      salePrice = dip.sale_price;
    } else if (allowEpddPriceFallbackMissingDip) {
      const epddPrice = parseOptionalStrictNonnegativeFloat(epdd.PIECE_PRICE);
      const epddCasePrice = parseOptionalStrictNonnegativeFloat(epdd.CASE_PRICE);
      piecePrice = epddPrice.valid ? epddPrice.value : undefined;
      casePrice = epddCasePrice.valid ? epddCasePrice.value : undefined;
    } else {
      missingDipCount++;
      skippedCount++;
      if (missingDipSamples.length < 5) missingDipSamples.push(uniqueKey);
      continue;
    }

    if (casePrice != null && casePrice > 0) {
      resolvedCost = casePrice;
      costBasis = 'casePrice';
    }

    if (resolvedCost == null || !Number.isFinite(resolvedCost) || resolvedCost <= 0) {
      skippedCount++;
      continue;
    }

    const variant = {
      sourceVariantId: uniqueKey,
      sourceStyleId: catalogNo,
      styleCode: catalogNo,
      color: epdd.COLOR_NAME || dip?.color || undefined,
      size: epdd.SIZE || dip?.size || undefined,
      sizeOrder: undefined,
      inventoryQty: dip ? dip.total_qty : undefined,
      imageUrl: epdd.PRODUCT_IMAGE || undefined,
      discontinued,
      piecePrice,
      dozenPrice: undefined,
      casePrice,
      salePrice: salePrice || undefined,
      customerPrice: undefined,
      resolvedCost,
      costBasis,
    };

    if (callbacks?.onVariant) await callbacks.onVariant(variant);
    variantCount++;
  }

  return {
    styles: Array.from(stylesMap.values()),
    styleCount: stylesMap.size,
    variantCount,
    skippedCount,
    missingDipCount,
    missingDipSamples,
  };
}

/**
 * Full SanMar ingestion from local EPDD + DIP files.
 * Streams DIP and join output without materializing full variant arrays.
 *
 * @param {Object} options
 * @param {ReadableStream|string} options.epddSource - EPDD file path or stream
 * @param {ReadableStream|string} options.dipSource - DIP file path or stream
 * @param {Date} [options.snapshotTime] - Current time for sale evaluation (default: now)
 * @param {Function} options.onStyle - Called with each VendorStyle
 * @param {Function} options.onVariant - Called with each VendorVariant
 * @param {Function} [options.shouldContinue] - Cancellation callback, called between phases
 * @returns {Promise<CompletenessManifest>}
 */
export async function ingestSanMar({
  epddSource,
  dipSource,
  snapshotTime,
  onStyle,
  onVariant,
  shouldContinue,
  checkIntervalRows,
  allowEpddPriceFallbackMissingDip = false,
}) {
  const snapshot = snapshotTime ?? new Date();

  // Check cancellation before EPDD parse
  if (shouldContinue && !(await shouldContinue())) {
    throw createSourceError(ErrorCategory.CANCELED, 'SanMar ingestion canceled before EPDD parse');
  }

  const epddResult = await parseEPDD(epddSource, { shouldContinue, checkIntervalRows });
  const epddProducts = epddResult.products;

  // Check cancellation between EPDD and DIP
  if (shouldContinue && !(await shouldContinue())) {
    throw createSourceError(ErrorCategory.CANCELED, 'SanMar ingestion canceled after EPDD parse');
  }

  const dipResult = await parseDIP(dipSource, snapshot, { shouldContinue, checkIntervalRows });
  const dipRecords = dipResult.records;

  // Check cancellation before join
  if (shouldContinue && !(await shouldContinue())) {
    throw createSourceError(ErrorCategory.CANCELED, 'SanMar ingestion canceled after DIP parse');
  }

  const hash = createHash('sha256');
  let styleCount = 0;
  let variantCount = 0;

  const { skippedCount, missingDipCount, missingDipSamples } = await joinEPDDAndDIP(epddProducts, dipRecords, {
    shouldContinue,
    checkIntervalRows,
    allowEpddPriceFallbackMissingDip,
    onStyle: async (style) => {
      hash.update(JSON.stringify(style) + '\n');
      styleCount++;
      await onStyle(style);
    },
    onVariant: async (variant) => {
      hash.update(JSON.stringify(variant) + '\n');
      variantCount++;
      await onVariant(variant);
    },
  });

  const totalMalformed = (epddResult.malformedCount || 0) + (dipResult.malformedCount || 0);
  const dipMissingEpddKeys = [];
  for (const uniqueKey of dipRecords.keys()) {
    if (!epddProducts.has(uniqueKey)) {
      dipMissingEpddKeys.push(uniqueKey);
      if (dipMissingEpddKeys.length >= 5) break;
    }
  }
  const dipMissingEpddCount = countKeysMissingFrom(dipRecords, epddProducts);
  const skippedInvalidSourceRows = Math.max(0, skippedCount - missingDipCount);
  const sourceErrors = totalMalformed + missingDipCount + dipMissingEpddCount + skippedInvalidSourceRows;
  const reasons = [];
  if (totalMalformed > 0) {
    reasons.push({ code: 'malformed_rows', count: totalMalformed });
  }
  if (missingDipCount > 0) {
    reasons.push({ code: 'epdd_keys_missing_dip', count: missingDipCount, samples: missingDipSamples });
  }
  if (dipMissingEpddCount > 0) {
    reasons.push({ code: 'dip_keys_missing_epdd', count: dipMissingEpddCount, samples: dipMissingEpddKeys });
  }
  if (skippedInvalidSourceRows > 0) {
    reasons.push({ code: 'invalid_source_rows', count: skippedInvalidSourceRows });
  }
  const complete = sourceErrors === 0;

  return {
    vendor: 'sanmar',
    styleCount,
    variantCount,
    skippedCount: skippedCount + totalMalformed + dipMissingEpddCount,
    sourceErrors,
    complete,
    contentHash: hash.digest('hex'),
    source: 'sanmar-epdd-dip',
    snapshotTimestamp: snapshot.toISOString(),
    reasons,
  };
}

// --- Internal helpers ---

function validateHeaders(actual, required, fileType, lineNum) {
  const actualSet = new Set(actual.map(h => h.toUpperCase()));
  const missing = required.filter(h => !actualSet.has(h.toUpperCase()));

  if (missing.length > 0) {
    throw createSourceError(
      ErrorCategory.SCHEMA,
      `${fileType} missing required headers: ${missing.join(', ')} (line ${lineNum})`,
      { retryable: false }
    );
  }
}

function canonicalizeEPDDHeader(header) {
  const normalized = header.trim().toUpperCase();
  return EPDD_HEADER_ALIASES.get(normalized) ?? normalized;
}

function canonicalizeDIPHeader(header) {
  const normalized = header.trim().toLowerCase();
  return DIP_HEADER_ALIASES.get(normalized) ?? normalized;
}

function mergeCategoryNames(left, right) {
  const parts = new Set();
  for (const value of [left, right]) {
    if (!value) continue;
    for (const part of String(value).split(';')) {
      const trimmed = part.trim();
      if (trimmed) parts.add(trimmed);
    }
  }
  return Array.from(parts).sort((a, b) => a.localeCompare(b)).join('; ');
}

function parseOptionalFloat(value) {
  if (value == null || value === '') return undefined;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStrictNonnegativeInteger(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseOptionalStrictNonnegativeFloat(value) {
  const normalized = String(value ?? '').trim();
  if (normalized === '') return { valid: true, value: undefined };
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
    return { valid: false, value: undefined };
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed)
    ? { valid: true, value: parsed }
    : { valid: false, value: undefined };
}

function pricesEqual(left, right) {
  return parseOptionalFloat(left) === parseOptionalFloat(right);
}

function normalizeCheckInterval(value) {
  const parsed = Number(value ?? DEFAULT_CHECK_INTERVAL_ROWS);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CHECK_INTERVAL_ROWS;
}

function countKeysMissingFrom(leftMap, rightMap) {
  let count = 0;
  for (const key of leftMap.keys()) {
    if (!rightMap.has(key)) count++;
  }
  return count;
}

function isDiscontinued(code) {
  const normalized = code?.trim().toUpperCase();
  return normalized === 'S' || normalized === 'M';
}

/**
 * Check if a sale is active at the given snapshot time.
 * Returns false if dates are missing or unparseable.
 */
function isSaleActive(startStr, endStr, snapshotTime) {
  if (!startStr || !endStr) return false;

  const start = new Date(startStr);
  const end = new Date(endStr);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) return false;

  return snapshotTime >= start && snapshotTime <= end;
}
