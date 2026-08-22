/**
 * Bounded retry helper for vendor source operations.
 *
 * Respects Retry-After headers, implements exponential backoff with jitter,
 * and enforces maximum attempt limits.
 */

import { ErrorCategory, createSourceError } from './contracts.mjs';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Execute an async function with bounded retries.
 *
 * @param {Function} fn - Async function to execute. Receives { attempt } argument.
 * @param {Object} options
 * @param {number} [options.maxRetries=3] - Maximum retry attempts
 * @param {number} [options.baseDelayMs=1000] - Base delay for exponential backoff
 * @param {number} [options.maxDelayMs=30000] - Maximum delay cap
 * @param {Function} [options.shouldRetry] - Custom predicate (error) => boolean
 * @param {Function} [options.sleep] - Injectable sleep for testing
 * @param {Function} [options.onRetry] - Callback before each retry
 * @param {AbortSignal} [options.signal] - Abort signal for cancellation
 * @returns {Promise<*>} Result of fn
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    shouldRetry = defaultShouldRetry,
    sleep = defaultSleep,
    onRetry,
    signal,
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw createSourceError(ErrorCategory.CANCELED, 'Operation canceled');
    }

    try {
      return await fn({ attempt });
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries || !shouldRetry(error)) {
        throw error;
      }

      const retryAfterMs = parseRetryAfter(error);
      const backoffMs = Math.min(
        baseDelayMs * Math.pow(2, attempt) + Math.random() * baseDelayMs,
        maxDelayMs
      );
      const delayMs = retryAfterMs != null ? Math.max(retryAfterMs, backoffMs) : backoffMs;

      if (onRetry) {
        onRetry({ attempt, error, delayMs });
      }

      if (signal) {
        await abortableSleep(delayMs, { signal });
      } else {
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

/**
 * Default retry predicate: retry on rate limits, server errors, timeouts, network errors.
 */
function defaultShouldRetry(error) {
  if (error.retryable === true) return true;
  if (error.retryable === false) return false;

  const category = error.category;
  if (category === ErrorCategory.RATE_LIMIT) return true;
  if (category === ErrorCategory.SERVER) return true;
  if (category === ErrorCategory.TIMEOUT) return true;
  if (category === ErrorCategory.NETWORK) return true;

  const status = error.statusCode;
  if (status === 429 || status === 503 || status === 502 || status === 504) return true;

  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
    return true;
  }

  return false;
}

/**
 * Parse Retry-After header value from error metadata.
 * Returns milliseconds to wait, or null if not present/parseable.
 */
function parseRetryAfter(error) {
  const value = error.retryAfter;
  if (value == null) return null;

  // Retry-After can be seconds (integer) or HTTP-date
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  // Try parsing as HTTP-date
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now();
    return ms > 0 ? ms : 0;
  }

  return null;
}

/**
 * Abortable sleep that exits immediately when any signal fires.
 * Combines per-request and global signals.
 *
 * @param {number} ms - Milliseconds to sleep
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] - Abort signal to interrupt sleep
 * @returns {Promise<void>}
 */
export function abortableSleep(ms, { signal } = {}) {
  if (signal?.aborted) {
    return Promise.reject(createSourceError(ErrorCategory.CANCELED, 'Sleep aborted'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(createSourceError(ErrorCategory.CANCELED, 'Sleep aborted'));
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
