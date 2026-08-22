/**
 * Normalized vendor data contracts for direct ingestion.
 *
 * All vendor adapters must yield objects conforming to these shapes.
 * The orchestrator maps them into catalog_styles / catalog_variants rows.
 */

/**
 * @typedef {Object} VendorStyle
 * @property {string} sourceStyleId - Vendor-specific style identifier
 * @property {string} styleCode - Display style code (e.g. "3001", "K500")
 * @property {string} [sourcePartNumber] - Vendor source part number when distinct from display style code
 * @property {string} [brand] - Brand name
 * @property {string} [name] - Style name/title
 * @property {string} [category] - Product category
 * @property {string} [description] - Style description
 * @property {string} [imageUrl] - Primary image URL
 */

/**
 * @typedef {Object} VendorVariant
 * @property {string} sourceVariantId - Vendor-specific variant identifier (unique within vendor)
 * @property {string} sourceStyleId - Parent style identifier (matches VendorStyle.sourceStyleId)
 * @property {string} styleCode - Display style code
 * @property {string} [color] - Color name
 * @property {string} [size] - Size label
 * @property {number} [sizeOrder] - Numeric sort order for sizes
 * @property {number} [inventoryQty] - Inventory quantity (may be 0; null = unknown)
 * @property {string} [imageUrl] - Variant-specific image URL
 * @property {boolean} discontinued - Whether variant is discontinued
 * @property {number} [piecePrice] - Per-piece price
 * @property {number} [dozenPrice] - Per-dozen price
 * @property {number} [casePrice] - Per-case price
 * @property {number} [salePrice] - Active sale price (null if no active sale)
 * @property {number} [customerPrice] - Account-specific negotiated price (S&S)
 * @property {number} resolvedCost - Best available cost (required, >= 0)
 * @property {string} costBasis - Which price field was used for resolvedCost
 */

/**
 * @typedef {Object} CompletenessManifest
 * @property {string} vendor - "ss" or "sanmar"
 * @property {number} styleCount - Total styles yielded
 * @property {number} variantCount - Total variants yielded
 * @property {number} skippedCount - Rows skipped due to invalid data
 * @property {string} contentHash - SHA-256 of all yielded data
 * @property {string} source - Source identifier (e.g. "ss-api", "sanmar-epdd-dip")
 * @property {string} [snapshotTimestamp] - ISO timestamp of data snapshot
 * @property {boolean} [complete] - Whether source completeness checks passed
 * @property {number} [sourceErrors] - Count of source completeness or parser errors
 * @property {Array<Object>} [reasons] - Redacted machine-readable incompleteness reasons
 */

/**
 * Error taxonomy for vendor source operations.
 * All errors from vendor sources must use one of these categories.
 */
export const ErrorCategory = Object.freeze({
  AUTH: 'auth',               // 401/403, invalid credentials
  RATE_LIMIT: 'rate_limit',   // 429, rate limit exceeded
  TIMEOUT: 'timeout',         // Request or operation timeout
  SERVER: 'server',           // 5xx from vendor
  NETWORK: 'network',         // Connection failures
  PARSE: 'parse',             // Malformed response data
  SCHEMA: 'schema',           // Missing/unexpected fields
  REDIRECT: 'redirect',       // Off-host redirect (SSRF)
  VALIDATION: 'validation',   // Data fails validation rules
  CANCELED: 'canceled',       // Job was canceled
  LOST_LEASE: 'lost_lease',   // Worker no longer owns the ingestion lease
});

/**
 * Create a redacted error with category classification.
 * Never includes request/response bodies or auth headers.
 */
export function createSourceError(category, message, { statusCode, url, retryable = false } = {}) {
  const redactedUrl = url ? redactUrl(url) : undefined;
  const error = new Error(message);
  error.category = category;
  error.statusCode = statusCode;
  error.url = redactedUrl;
  error.retryable = retryable;
  return error;
}

/**
 * Redact credentials from URLs for safe logging/storage.
 */
export function redactUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

/**
 * Redact a string to a safe summary for error storage.
 * Truncates to maxLength and strips patterns that look like credentials.
 */
export function redactErrorSummary(message, maxLength = 2000) {
  if (typeof message !== 'string') return '[non-string-error]';
  return message
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic ***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/api[_\s-]*key[=:]?\s*[^\s&]+/gi, 'api_key=***')
    .replace(/key[=:]\s*[^\s&]+/gi, 'key=***')
    .replace(/password[=:]\s*[^\s&]+/gi, 'password=***')
    .replace(/secret[=:]\s*[^\s&]+/gi, 'secret=***')
    .replace(/response[_\s-]*body[_\s-]*sentinel/gi, '[redacted-response-body]')
    .slice(0, maxLength);
}
