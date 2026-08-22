/**
 * Fixed-origin HTTP request helper with SSRF protection.
 *
 * Only allows requests to a pre-declared origin. Rejects redirects
 * to different hosts. Never logs request/response bodies or auth headers.
 */

import { ErrorCategory, createSourceError, redactUrl } from './contracts.mjs';
import { withRetry } from './retry.mjs';

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Create a fixed-origin HTTP client for a vendor API.
 *
 * @param {Object} options
 * @param {string} options.origin - Fixed origin (e.g. "https://api.ssactivewear.com")
 * @param {Object} [options.defaultHeaders] - Headers included on every request
 * @param {number} [options.timeoutMs] - Request timeout in ms
 * @param {Function} [options.fetch] - Injectable fetch for testing
 * @param {Function} [options.sleep] - Injectable sleep for testing
 * @param {AbortSignal} [options.signal] - Global abort signal
 * @returns {Object} Client with get() method
 */
export function createFixedOriginClient({
  origin,
  defaultHeaders = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetch: fetchFn = globalThis.fetch,
  sleep,
  signal: globalSignal,
}) {
  // Validate and normalize the origin
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.protocol !== 'https:') {
    throw new Error(`Origin must use HTTPS: ${origin}`);
  }
  const normalizedOrigin = parsedOrigin.origin;

  /**
   * Make a GET request to a path on the fixed origin.
   *
   * @param {string} path - URL path (e.g. "/v2/styles/")
   * @param {Object} [options]
   * @param {Object} [options.headers] - Additional headers
   * @param {Object} [options.query] - Query parameters
   * @param {number} [options.retries] - Max retries (default 3)
   * @param {AbortSignal} [options.signal] - Per-request abort signal
   * @returns {Promise<Object>} Parsed JSON response
   */
  async function get(path, options = {}) {
    const { headers = {}, query, retries = 3, signal: requestSignal } = options;

    const url = buildUrl(normalizedOrigin, path, query);
    validateUrl(url, normalizedOrigin);

    return withRetry(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        // Compose abort signals
        const abortHandler = () => controller.abort();
        globalSignal?.addEventListener('abort', abortHandler, { once: true });
        requestSignal?.addEventListener('abort', abortHandler, { once: true });

        try {
          const response = await fetchFn(url, {
            method: 'GET',
            headers: { ...defaultHeaders, ...headers },
            signal: controller.signal,
            redirect: 'manual', // Handle redirects ourselves for SSRF protection
          });

          // Check for redirects - resolve relative, reject off-origin
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (location) {
              // Resolve relative redirects against current URL
              const resolved = new URL(location, url);
              assertSameOrigin(resolved.toString(), normalizedOrigin);
            }
            throw createSourceError(
              ErrorCategory.REDIRECT,
              `Unexpected redirect ${response.status} from ${redactUrl(url)}`,
              { statusCode: response.status, url, retryable: false }
            );
          }

          if (response.status === 401 || response.status === 403) {
            throw createSourceError(
              ErrorCategory.AUTH,
              `Authentication failed (${response.status})`,
              { statusCode: response.status, url, retryable: false }
            );
          }

          if (response.status === 429) {
            const retryAfter = response.headers.get('retry-after');
            const rateLimitRemaining = response.headers.get('x-rate-limit-remaining');
            const error = createSourceError(
              ErrorCategory.RATE_LIMIT,
              `Rate limited (429). Remaining: ${rateLimitRemaining ?? 'unknown'}`,
              { statusCode: 429, url, retryable: true }
            );
            if (retryAfter) error.retryAfter = retryAfter;
            throw error;
          }

          if (response.status >= 500) {
            throw createSourceError(
              ErrorCategory.SERVER,
              `Server error (${response.status})`,
              { statusCode: response.status, url, retryable: true }
            );
          }

          if (!response.ok) {
            throw createSourceError(
              ErrorCategory.SERVER,
              `HTTP ${response.status}`,
              { statusCode: response.status, url, retryable: false }
            );
          }

          // Parse JSON response
          let data;
          try {
            data = await response.json();
          } catch (parseError) {
            throw createSourceError(
              ErrorCategory.PARSE,
              'Failed to parse JSON response',
              { url, retryable: false }
            );
          }

          return {
            data,
            headers: {
              rateLimitRemaining: response.headers.get('x-rate-limit-remaining'),
              retryAfter: response.headers.get('retry-after'),
            },
          };
        } catch (error) {
          if (error.category) throw error; // Already classified

          if (error.name === 'AbortError') {
            if (globalSignal?.aborted || requestSignal?.aborted) {
              throw createSourceError(ErrorCategory.CANCELED, 'Request canceled', { url });
            }
            throw createSourceError(
              ErrorCategory.TIMEOUT,
              `Request timed out after ${timeoutMs}ms`,
              { url, retryable: true }
            );
          }

          throw createSourceError(
            ErrorCategory.NETWORK,
            `Network error: ${error.code || error.message}`,
            { url, retryable: true }
          );
        } finally {
          clearTimeout(timeoutId);
          globalSignal?.removeEventListener('abort', abortHandler);
          requestSignal?.removeEventListener('abort', abortHandler);
        }
      },
      {
        maxRetries: retries,
        sleep,
        // Combine per-request and global signals for retry sleep abort
        signal: requestSignal && globalSignal
          ? AbortSignal.any([requestSignal, globalSignal])
          : requestSignal || globalSignal,
      }
    );
  }

  return { get };
}

function buildUrl(origin, path, query) {
  const url = new URL(path, origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value != null) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

function validateUrl(url, expectedOrigin) {
  const parsed = new URL(url);
  if (parsed.origin !== expectedOrigin) {
    throw createSourceError(
      ErrorCategory.REDIRECT,
      `URL origin ${parsed.origin} does not match expected ${expectedOrigin}`,
      { url, retryable: false }
    );
  }
}

function assertSameOrigin(url, expectedOrigin) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== expectedOrigin) {
      throw createSourceError(
        ErrorCategory.REDIRECT,
        `Redirect to different origin: ${parsed.origin} (expected ${expectedOrigin})`,
        { url, retryable: false }
      );
    }
  } catch (error) {
    if (error.category) throw error;
    throw createSourceError(
      ErrorCategory.REDIRECT,
      `Invalid redirect URL`,
      { retryable: false }
    );
  }
}
