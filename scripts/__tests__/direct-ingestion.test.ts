import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  ErrorCategory,
  createSourceError,
  redactUrl,
  redactErrorSummary,
} from '../lib/vendor-sources/contracts.mjs';
import { withRetry, abortableSleep } from '../lib/vendor-sources/retry.mjs';
import { createFixedOriginClient } from '../lib/vendor-sources/http.mjs';
import { createSSSource } from '../lib/vendor-sources/ss.mjs';
import {
  parseEPDD,
  parseDIP,
  joinEPDDAndDIP,
  ingestSanMar,
  ingestSanMarSDLN,
} from '../lib/vendor-sources/sanmar.mjs';
import { assertManifestCompleteForActivation } from '../sync-vendor-catalog.mjs';
import {
  SS_STYLES_RESPONSE,
  SS_PRODUCTS_BATCH_1,
  SS_PRODUCTS_BATCH_2,
  SS_PRODUCT_NO_PRICE,
  SS_PRODUCT_NO_SKU,
  SS_PRODUCT_ZERO_PIECE_WITH_SPECIAL,
  SS_PRODUCT_NEGATIVE_PIECE,
  SS_STYLE_MISSING_FIELDS,
} from '../../tests/fixtures/vendor-sources/ss-fixtures.mjs';
import {
  streamFromString,
  EPDD_VALID_CONTENT,
  EPDD_WITH_QUOTES,
  EPDD_MISSING_HEADERS,
  EPDD_EMPTY,
  EPDD_DUPLICATE_CONFLICTING,
  EPDD_DUPLICATE_CATEGORY_MERGE,
  DIP_VALID_CONTENT,
  DIP_DISCONTINUED,
  DIP_MISSING_HEADERS,
  DIP_EMPTY,
  DIP_DUPLICATE_CONFLICTING,
  DIP_EXPIRED_SALE,
  DIP_FUTURE_SALE,
  DIP_ZERO_INVENTORY,
  DIP_HEADERS,
  EPDD_HEADERS,
  SDLN_VALID_CONTENT,
  SDLN_STATUS_CONTENT,
  SDLN_MISSING_HEADERS,
  SDLN_DUPLICATE_CASE_PRICE_HEADER,
  SDLN_DUPLICATE_CANONICAL_ALIAS_HEADER,
  SDLN_UNKNOWN_STATUS,
  SDLN_MALFORMED_CASE_PRICE,
  SDLN_ZERO_CASE_PRICE,
  SDLN_DUPLICATE_CONFLICTING,
  SDLN_DUPLICATE_IDENTICAL,
  SDLN_MALFORMED_CSV,
} from '../../tests/fixtures/vendor-sources/sanmar-fixtures.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

function streamFrom(content: string) {
  return Readable.from(content.split('\n').map((line) => line + '\n'));
}

function streamFromExact(content: string) {
  return Readable.from([content]);
}

function sha256(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

function writeTempSDLN(content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cmp-sdln-'));
  const path = join(dir, 'SanMar_SDL_N.csv');
  writeFileSync(path, content);
  return {
    dir,
    path,
    expectedSourceSha256: sha256(content),
  };
}

async function withTempSDLN<T>(
  content: string,
  callback: (file: { path: string; expectedSourceSha256: string }) => Promise<T>
) {
  const file = writeTempSDLN(content);
  try {
    return await callback(file);
  } finally {
    rmSync(file.dir, { recursive: true, force: true });
  }
}

// ─── Redaction ────────────────────────────────────────────────────

describe('Error redaction', () => {
  it('redacts Basic auth from error messages', () => {
    const result = redactErrorSummary('Failed with Basic dXNlcjpwYXNz credentials');
    expect(result).toContain('Basic ***');
    expect(result).not.toContain('dXNlcjpwYXNz');
  });

  it('redacts Bearer tokens', () => {
    const result = redactErrorSummary('Token Bearer abc123.def456.ghi789 expired');
    expect(result).toContain('Bearer ***');
    expect(result).not.toContain('abc123');
  });

  it('redacts key= patterns', () => {
    const result = redactErrorSummary('api key=secretvalue123 used');
    expect(result).toContain('key=***');
    expect(result).not.toContain('secretvalue123');
  });

  it('redacts password= patterns', () => {
    const result = redactErrorSummary('password=hunter2 in config');
    expect(result).toContain('password=***');
    expect(result).not.toContain('hunter2');
  });

  it('truncates long messages', () => {
    const long = 'x'.repeat(5000);
    expect(redactErrorSummary(long)).toHaveLength(2000);
  });

  it('handles non-string input', () => {
    expect(redactErrorSummary(null as any)).toBe('[non-string-error]');
    expect(redactErrorSummary(undefined as any)).toBe('[non-string-error]');
  });

  it('redacts credentials from URLs', () => {
    expect(redactUrl('https://user:pass@api.example.com/v2')).toContain('***');
    expect(redactUrl('https://user:pass@api.example.com/v2')).not.toContain('user');
    expect(redactUrl('https://user:pass@api.example.com/v2')).not.toContain('pass');
  });

  it('handles invalid URL input', () => {
    expect(redactUrl('not-a-url')).toBe('[invalid-url]');
  });

  it('preserves URLs without credentials', () => {
    expect(redactUrl('https://api.example.com/v2')).toBe('https://api.example.com/v2');
  });
});

// ─── SSRF / Redirect Protection ──────────────────────────────────

describe('Fixed-origin HTTP client', () => {
  it('rejects non-HTTPS origins', () => {
    expect(() =>
      createFixedOriginClient({
        origin: 'http://api.example.com',
        fetch: vi.fn(),
      })
    ).toThrow(/HTTPS/);
  });

  it('rejects off-host redirects', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 302,
      ok: false,
      headers: new Map([['location', 'https://evil.example.com/steal']]),
    });

    const client = createFixedOriginClient({
      origin: 'https://api.ssactivewear.com',
      fetch: mockFetch,
    });

    await expect(client.get('/v2/styles/')).rejects.toThrow(/different origin/i);
  });

  it('rejects off-port same-host redirects', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 301,
      ok: false,
      headers: new Map([['location', 'https://api.ssactivewear.com:8443/v2/styles/']]),
    });

    const client = createFixedOriginClient({
      origin: 'https://api.ssactivewear.com',
      fetch: mockFetch,
    });

    await expect(client.get('/v2/styles/')).rejects.toThrow(/different origin/i);
  });

  it('resolves same-origin relative redirect without error', async () => {
    // Relative redirects resolved against the current URL should be same-origin
    const mockFetch = vi.fn().mockResolvedValue({
      status: 301,
      ok: false,
      headers: new Map([['location', '/v2/styles-new/']]),
    });

    const client = createFixedOriginClient({
      origin: 'https://api.ssactivewear.com',
      fetch: mockFetch,
    });

    // Should throw redirect error (we don't follow redirects) but NOT an origin error
    try {
      await client.get('/v2/styles/');
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.category).toBe(ErrorCategory.REDIRECT);
      // Should be "Unexpected redirect" not "different origin"
      expect(error.message).toContain('Unexpected redirect');
      expect(error.message).not.toContain('different origin');
    }
  });

  it('classifies 429 as rate_limit with retryable=true', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 429,
      ok: false,
      headers: new Map([
        ['retry-after', '30'],
        ['x-rate-limit-remaining', '0'],
      ]),
    });

    const client = createFixedOriginClient({
      origin: 'https://api.ssactivewear.com',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    try {
      await client.get('/v2/styles/', { retries: 0 });
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.category).toBe(ErrorCategory.RATE_LIMIT);
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBe('30');
    }
  });

  it('classifies 503 as server error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 503,
      ok: false,
      headers: new Map(),
    });

    const client = createFixedOriginClient({
      origin: 'https://api.ssactivewear.com',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    try {
      await client.get('/v2/styles/', { retries: 0 });
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.category).toBe(ErrorCategory.SERVER);
      expect(error.retryable).toBe(true);
    }
  });

  it('classifies 401 as auth error (non-retryable)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
      headers: new Map(),
    });

    const client = createFixedOriginClient({
      origin: 'https://api.ssactivewear.com',
      fetch: mockFetch,
    });

    try {
      await client.get('/v2/styles/', { retries: 0 });
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.category).toBe(ErrorCategory.AUTH);
      expect(error.retryable).toBe(false);
    }
  });

  it('classifies malformed JSON as parse error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    });

    const client = createFixedOriginClient({
      origin: 'https://api.ssactivewear.com',
      fetch: mockFetch,
    });

    try {
      await client.get('/v2/styles/', { retries: 0 });
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.category).toBe(ErrorCategory.PARSE);
    }
  });

  it('classifies timeout as timeout error', async () => {
    const mockFetch = vi.fn().mockImplementation(() => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    });

    const client = createFixedOriginClient({
      origin: 'https://api.ssactivewear.com',
      fetch: mockFetch,
      timeoutMs: 100,
    });

    try {
      await client.get('/v2/styles/', { retries: 0 });
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.category).toBe(ErrorCategory.TIMEOUT);
    }
  });

  it('does not include auth headers in error objects', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      headers: new Map(),
    });

    const client = createFixedOriginClient({
      origin: 'https://api.ssactivewear.com',
      defaultHeaders: { Authorization: 'Basic dXNlcjpwYXNz' },
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    try {
      await client.get('/v2/styles/', { retries: 0 });
    } catch (error: any) {
      expect(JSON.stringify(error)).not.toContain('dXNlcjpwYXNz');
      expect(error.message).not.toContain('dXNlcjpwYXNz');
    }
  });
});

// ─── Retry Helper ────────────────────────────────────────────────

describe('Retry helper', () => {
  it('retries on 429', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          const error = createSourceError(ErrorCategory.RATE_LIMIT, '429', {
            statusCode: 429,
            retryable: true,
          });
          throw error;
        }
        return 'success';
      },
      { sleep: vi.fn(), maxRetries: 3 }
    );
    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('retries on 503', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 2) {
          throw createSourceError(ErrorCategory.SERVER, '503', {
            statusCode: 503,
            retryable: true,
          });
        }
        return 'ok';
      },
      { sleep: vi.fn(), maxRetries: 3 }
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('retries on timeout', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 2) {
          throw createSourceError(ErrorCategory.TIMEOUT, 'timeout', {
            retryable: true,
          });
        }
        return 'ok';
      },
      { sleep: vi.fn(), maxRetries: 3 }
    );
    expect(result).toBe('ok');
  });

  it('does not retry auth errors', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw createSourceError(ErrorCategory.AUTH, '401', {
            statusCode: 401,
            retryable: false,
          });
        },
        { sleep: vi.fn(), maxRetries: 3 }
      )
    ).rejects.toThrow(/401/);
    expect(attempts).toBe(1);
  });

  it('respects Retry-After header', async () => {
    const sleepFn = vi.fn();
    let attempts = 0;

    await withRetry(
      async () => {
        attempts++;
        if (attempts < 2) {
          const error = createSourceError(ErrorCategory.RATE_LIMIT, '429', {
            statusCode: 429,
            retryable: true,
          });
          (error as any).retryAfter = '5';
          throw error;
        }
        return 'ok';
      },
      { sleep: sleepFn, maxRetries: 3 }
    );

    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(sleepFn.mock.calls[0][0]).toBeGreaterThanOrEqual(5000);
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      withRetry(
        async () => 'should not run',
        { signal: controller.signal, sleep: vi.fn() }
      )
    ).rejects.toThrow(/canceled/i);
  });

  it('limits to maxRetries', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw createSourceError(ErrorCategory.SERVER, '500', {
            statusCode: 500,
            retryable: true,
          });
        },
        { sleep: vi.fn(), maxRetries: 2 }
      )
    ).rejects.toThrow(/500/);
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it('abortable sleep exits immediately when signal fires', async () => {
    const controller = new AbortController();
    const start = Date.now();

    // Schedule abort after 10ms
    setTimeout(() => controller.abort(), 10);

    await expect(
      abortableSleep(60_000, { signal: controller.signal })
    ).rejects.toThrow(/aborted/i);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // Should exit well before 60s
  });

  it('abortable sleep rejects immediately when signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      abortableSleep(60_000, { signal: controller.signal })
    ).rejects.toThrow(/aborted/i);
  });

  it('abortable sleep resolves normally without signal', async () => {
    await abortableSleep(10);
    // Should not throw
  });

  it('cancellation during Retry-After exits retry loop immediately', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const start = Date.now();

    // Abort after 50ms (well before the Retry-After 60s delay)
    setTimeout(() => controller.abort(), 50);

    await expect(
      withRetry(
        async () => {
          attempts++;
          const error = createSourceError(ErrorCategory.RATE_LIMIT, '429', {
            statusCode: 429,
            retryable: true,
          });
          (error as any).retryAfter = '60';
          throw error;
        },
        { maxRetries: 3, signal: controller.signal }
      )
    ).rejects.toThrow(/aborted|canceled/i);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(attempts).toBe(1);
  });
});

// ─── S&S Adapter ─────────────────────────────────────────────────

describe('S&S adapter', () => {
  it('requires credentials', () => {
    expect(() =>
      createSSSource({ accountNumber: '', apiKey: 'key', fetch: vi.fn(), sleep: vi.fn() })
    ).toThrow(/credentials/i);
  });

  it('normalizes styles from API response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve(SS_STYLES_RESPONSE),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const styles = await source.fetchStyles();
    expect(styles).toHaveLength(3);
    expect(styles[0]).toEqual({
      sourceStyleId: '101',
      styleCode: '3001',
      brand: 'BELLA+CANVAS',
      name: 'Jersey Tee',
      category: 'T-Shirts',
      description: 'Soft unisex tee',
      imageUrl: 'https://cdn.example.com/3001.jpg',
    });
  });

  it('maps style partNumber as optional sourcePartNumber while keeping styleName as styleCode', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve([{
        ...SS_STYLES_RESPONSE[0],
        styleName: '3001',
        partNumber: 'BC3001',
      }]),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const styles = await source.fetchStyles();
    expect(styles[0].styleCode).toBe('3001');
    expect((styles[0] as any).sourcePartNumber).toBe('BC3001');
  });

  it('rejects non-array styles response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve({ error: 'not an array' }),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    await expect(source.fetchStyles()).rejects.toThrow(/not an array/i);
  });

  it('malformed style throws (fail closed)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve([SS_STYLE_MISSING_FIELDS]),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    await expect(source.fetchStyles()).rejects.toThrow(/missing required field/i);
  });

  it('malformed product throws (fail closed) on missing sku', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve([SS_PRODUCT_NO_SKU]),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const products: any[] = [];
    await expect(async () => {
      for await (const p of source.fetchProducts(['101'])) {
        products.push(p);
      }
    }).rejects.toThrow(/missing required field.*sku/i);
  });

  it('batches product requests to max 50 style IDs', async () => {
    const fetchCalls: string[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      fetchCalls.push(url);
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: new Map(),
        json: () => Promise.resolve([]),
      });
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    // 120 style IDs should require 3 batches (50+50+20)
    const styleIds = Array.from({ length: 120 }, (_, i) => String(i));
    const products: any[] = [];
    for await (const p of source.fetchProducts(styleIds)) {
      products.push(p);
    }

    expect(fetchCalls).toHaveLength(3);
    const url1 = new URL(fetchCalls[0]);
    const ids1 = url1.searchParams.get('styleid')!.split(',');
    expect(ids1).toHaveLength(50);
  });

  it('resolves S&S cost to piecePrice (ignoring customerPrice/salePrice)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve(SS_PRODUCTS_BATCH_1),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const products: any[] = [];
    for await (const p of source.fetchProducts(['101', '102'])) {
      products.push(p);
    }

    // customerPrice=4.25 is lower, but resolvedCost must be piecePrice=5.50
    const blkS = products.find((p: any) => p.sourceVariantId === 'SS-3001-BLK-S');
    expect(blkS?.resolvedCost).toBe(5.50);
    expect(blkS?.costBasis).toBe('piecePrice');

    const whtL = products.find((p: any) => p.sourceVariantId === 'SS-3001-WHT-L');
    expect(whtL?.resolvedCost).toBe(5.50);
    expect(whtL?.costBasis).toBe('piecePrice');
  });

  it('resolves S&S cost to piecePrice even when customerPrice/salePrice are lower', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve(SS_PRODUCTS_BATCH_1),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const products: any[] = [];
    for await (const p of source.fetchProducts(['101', '102'])) {
      products.push(p);
    }

    // SS-3001-BLK-S: customerPrice=4.25, salePrice=0, piecePrice=5.50
    // Business rule: always use piecePrice (regular S&S price)
    const blkS = products.find((p: any) => p.sourceVariantId === 'SS-3001-BLK-S');
    expect(blkS?.resolvedCost).toBe(5.50);
    expect(blkS?.costBasis).toBe('piecePrice');

    // SS-3001-BLK-M: customerPrice=4.25, salePrice=3.99, piecePrice=5.50
    const blkM = products.find((p: any) => p.sourceVariantId === 'SS-3001-BLK-M');
    expect(blkM?.resolvedCost).toBe(5.50);
    expect(blkM?.costBasis).toBe('piecePrice');

    // SS-5000-RED-XL: customerPrice=3.10, salePrice=0, piecePrice=4.00
    const redXL = products.find((p: any) => p.sourceVariantId === 'SS-5000-RED-XL');
    expect(redXL?.resolvedCost).toBe(4.00);
    expect(redXL?.costBasis).toBe('piecePrice');

    // Raw price fields preserved for audit
    expect(blkS?.customerPrice).toBe(4.25);
    expect(blkM?.salePrice).toBe(3.99);
    expect(blkM?.customerPrice).toBe(4.25);
  });

  it('skips S&S variant when piecePrice is zero even if customerPrice/salePrice are valid', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve([SS_PRODUCT_ZERO_PIECE_WITH_SPECIAL]),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const products: any[] = [];
    for await (const p of source.fetchProducts(['101'])) {
      products.push(p);
    }

    // piecePrice=0, customerPrice=4.25, salePrice=3.99 → fail closed, no fallback
    expect(products).toHaveLength(0);
  });

  it('products without valid price are not yielded', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve([SS_PRODUCT_NO_PRICE]),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const products: any[] = [];
    for await (const p of source.fetchProducts(['101'])) {
      products.push(p);
    }
    expect(products).toHaveLength(0);
  });

  it('counts price-less validated products as skipped during ingest', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname === '/v2/styles/') {
        return Promise.resolve({
          status: 200,
          ok: true,
          headers: new Map(),
          json: () => Promise.resolve([SS_STYLES_RESPONSE[0]]),
        });
      }
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: new Map(),
        json: () => Promise.resolve([SS_PRODUCTS_BATCH_1[0], SS_PRODUCT_NO_PRICE]),
      });
    });

    const variants: any[] = [];
    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const manifest = await source.ingest({
      onStyle: () => {},
      onVariant: (v: any) => { variants.push(v); },
    });

    expect(manifest.skippedCount).toBe(1);
    expect(manifest.variantCount).toBe(1);
    expect(manifest.complete).toBe(false);
    expect(manifest.sourceErrors).toBe(1);
    expect(manifest.reasons).toContainEqual({
      code: 'ss_style_incomplete',
      styleId: '101',
      rawProductCount: 2,
      usableVariantCount: 1,
    });
    expect(() => assertManifestCompleteForActivation(manifest)).toThrow(/refusing activation/i);
    expect(variants).toHaveLength(1);
  });

  it('marks manifest incomplete when a requested style has no raw products', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname === '/v2/styles/') {
        return Promise.resolve({
          status: 200,
          ok: true,
          headers: new Map(),
          json: () => Promise.resolve(SS_STYLES_RESPONSE.slice(0, 2)),
        });
      }
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: new Map(),
        json: () => Promise.resolve([SS_PRODUCTS_BATCH_1[0]]),
      });
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const manifest = await source.ingest({
      onStyle: () => {},
      onVariant: () => {},
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.reasons).toContainEqual({
      code: 'ss_style_incomplete',
      styleId: '102',
      rawProductCount: 0,
      usableVariantCount: 0,
    });
  });

  it('marks manifest incomplete when a requested style has raw products but zero usable priced variants', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname === '/v2/styles/') {
        return Promise.resolve({
          status: 200,
          ok: true,
          headers: new Map(),
          json: () => Promise.resolve([SS_STYLES_RESPONSE[0]]),
        });
      }
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: new Map(),
        json: () => Promise.resolve([SS_PRODUCT_NO_PRICE]),
      });
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const manifest = await source.ingest({
      onStyle: () => {},
      onVariant: () => {},
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.skippedCount).toBe(1);
    expect(manifest.reasons).toContainEqual({
      code: 'ss_style_incomplete',
      styleId: '101',
      rawProductCount: 1,
      usableVariantCount: 0,
    });
  });

  it('marks an empty products response for a requested batch incomplete', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname === '/v2/styles/') {
        return Promise.resolve({
          status: 200,
          ok: true,
          headers: new Map(),
          json: () => Promise.resolve([SS_STYLES_RESPONSE[0]]),
        });
      }
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: new Map(),
        json: () => Promise.resolve([]),
      });
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const manifest = await source.ingest({
      onStyle: () => {},
      onVariant: () => {},
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.reasons?.[0]).toMatchObject({
      styleId: '101',
      rawProductCount: 0,
      usableVariantCount: 0,
    });
  });

  it('maps documented S&S fields including sizeOrder, dozenPrice, casePrice', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve([{
        ...SS_PRODUCTS_BATCH_1[0],
        sizeOrder: '20',
        dozenPrice: 48.00,
        casePrice: 40.00,
        colorFrontImage: 'https://cdn.example.com/3001-blk-front.jpg',
      }]),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const products: any[] = [];
    for await (const p of source.fetchProducts(['101'])) {
      products.push(p);
    }

    expect(products).toHaveLength(1);
    expect(products[0].sizeOrder).toBe(20);
    expect(products[0].dozenPrice).toBe(48.00);
    expect(products[0].casePrice).toBe(40.00);
    expect(products[0].imageUrl).toBe('https://cdn.example.com/3001-blk-front.jpg');
  });

  it('validates documented warehouse objects and sums them only when aggregate qty is absent', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve([{
        ...SS_PRODUCTS_BATCH_1[0],
        qty: undefined,
        warehouses: [
          { warehouseAbbr: 'IL', qty: 7 },
          { warehouseAbbr: 'TX', qty: '5' },
        ],
      }]),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const products: any[] = [];
    for await (const p of source.fetchProducts(['101'])) {
      products.push(p);
    }

    expect(products[0].inventoryQty).toBe(12);
    expect(products[0]).not.toHaveProperty('warehouses');
  });

  it('retains documented aggregate qty when warehouse sum disagrees', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve([{
        ...SS_PRODUCTS_BATCH_1[0],
        qty: 42,
        warehouses: [
          { warehouseAbbr: 'IL', qty: 7 },
          { warehouseAbbr: 'TX', qty: 5 },
        ],
      }]),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const products: any[] = [];
    for await (const p of source.fetchProducts(['101'])) {
      products.push(p);
    }

    expect(products[0].inventoryQty).toBe(42);
  });

  it('rejects malformed warehouse details', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve([{
        ...SS_PRODUCTS_BATCH_1[0],
        warehouses: [{ warehouseAbbr: 'IL', qty: -1 }],
      }]),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    await expect(async () => {
      for await (const _p of source.fetchProducts(['101'])) {
        // consume iterator
      }
    }).rejects.toThrow(/warehouse.*invalid qty/i);
  });

  it('rejects products returned for unrequested styles', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve([SS_PRODUCTS_BATCH_1[0]]),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    await expect(async () => {
      for await (const _p of source.fetchProducts(['102'])) {
        // consume iterator
      }
    }).rejects.toThrow(/unrequested style/i);
  });

  it('rejects duplicate SKUs with conflicting identity', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve([
        SS_PRODUCTS_BATCH_1[0],
        { ...SS_PRODUCTS_BATCH_1[0], colorName: 'White' },
      ]),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    await expect(async () => {
      for await (const _p of source.fetchProducts(['101'])) {
        // consume iterator
      }
    }).rejects.toThrow(/duplicate sku with conflicting identity/i);
  });

  it('rejects duplicate product emission across batches', async () => {
    const styleIds = ['101', ...Array.from({ length: 49 }, (_, i) => `x${i}`), '101'];
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve([SS_PRODUCTS_BATCH_1[0]]),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    await expect(async () => {
      for await (const _p of source.fetchProducts(styleIds)) {
        // consume iterator
      }
    }).rejects.toThrow(/duplicate product emission across batches/i);
  });

  it('aborts low-rate-limit sleep via the global signal', async () => {
    const controller = new AbortController();
    const sleep = vi.fn(() => new Promise<void>(() => {}));
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map([['x-rate-limit-remaining', '1']]),
      json: () => Promise.resolve([]),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep,
      signal: controller.signal,
    });

    const promise = (async () => {
      for await (const _p of source.fetchProducts(['101'])) {
        // consume iterator
      }
    })();
    for (let i = 0; i < 20 && sleep.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort();

    await expect(promise).rejects.toThrow(/aborted/i);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('full ingest yields completeness manifest', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      callCount++;
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname === '/v2/styles/') {
        return Promise.resolve({
          status: 200,
          ok: true,
          headers: new Map(),
          json: () => Promise.resolve(SS_STYLES_RESPONSE),
        });
      }
      const styleIds = parsedUrl.searchParams.get('styleid')?.split(',') ?? [];
      const products = [
        ...SS_PRODUCTS_BATCH_1.filter((p) => styleIds.includes(String(p.styleID))),
        ...SS_PRODUCTS_BATCH_2.filter((p) => styleIds.includes(String(p.styleID))),
      ];
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: new Map(),
        json: () => Promise.resolve(products),
      });
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const styles: any[] = [];
    const variants: any[] = [];
    const manifest = await source.ingest({
      onStyle: (s: any) => { styles.push(s); },
      onVariant: (v: any) => { variants.push(v); },
    });

    expect(manifest.vendor).toBe('ss');
    expect(manifest.styleCount).toBe(3);
    expect(manifest.variantCount).toBeGreaterThan(0);
    expect(manifest.contentHash).toBeTruthy();
    expect(manifest.source).toBe('ss-api');
    expect(manifest.complete).toBe(true);
    expect(manifest.sourceErrors).toBe(0);
    expect(styles).toHaveLength(3);
    expect(variants.length).toBe(manifest.variantCount);
  });

  it('does not include secrets in fetch URL', async () => {
    const fetchCalls: string[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      fetchCalls.push(url);
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: new Map(),
        json: () => Promise.resolve([]),
      });
    });

    const source = createSSSource({
      accountNumber: 'MY_SECRET_ACCOUNT',
      apiKey: 'MY_SECRET_KEY',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    await source.fetchStyles();
    for (const url of fetchCalls) {
      expect(url).not.toContain('MY_SECRET_ACCOUNT');
      expect(url).not.toContain('MY_SECRET_KEY');
    }
  });

  it('skips S&S variant when piecePrice is negative even if customerPrice/salePrice are valid', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: () => Promise.resolve([SS_PRODUCT_NEGATIVE_PIECE]),
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const products: any[] = [];
    for await (const p of source.fetchProducts(['101'])) {
      products.push(p);
    }

    // piecePrice=-1, customerPrice=4.25, salePrice=3.99 → fail closed, no fallback
    expect(products).toHaveLength(0);
  });

  it('negative piecePrice is counted as skipped during ingest (not imported)', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname === '/v2/styles/') {
        return Promise.resolve({
          status: 200,
          ok: true,
          headers: new Map(),
          json: () => Promise.resolve([SS_STYLES_RESPONSE[0]]),
        });
      }
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: new Map(),
        json: () => Promise.resolve([SS_PRODUCTS_BATCH_1[0], SS_PRODUCT_NEGATIVE_PIECE]),
      });
    });

    const variants: any[] = [];
    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const manifest = await source.ingest({
      onStyle: () => {},
      onVariant: (v: any) => { variants.push(v); },
    });

    expect(manifest.skippedCount).toBe(1);
    expect(manifest.variantCount).toBe(1);
    expect(variants).toHaveLength(1);
    // The valid variant should have positive piecePrice
    expect(variants[0].resolvedCost).toBe(5.50);
    expect(variants[0].costBasis).toBe('piecePrice');
  });

  it('cancellation aborts S&S fetch between batches', async () => {
    let batchesFetched = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname === '/v2/styles/') {
        return Promise.resolve({
          status: 200,
          ok: true,
          headers: new Map(),
          json: () => Promise.resolve(SS_STYLES_RESPONSE),
        });
      }
      batchesFetched++;
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: new Map(),
        json: () => Promise.resolve(SS_PRODUCTS_BATCH_1),
      });
    });

    const source = createSSSource({
      accountNumber: 'test',
      apiKey: 'test',
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    let cancelAfter = 1;
    await expect(
      source.ingest({
        onStyle: () => {},
        onVariant: () => {},
        shouldContinue: async () => {
          cancelAfter--;
          return cancelAfter >= 0;
        },
      })
    ).rejects.toThrow(/canceled/i);
  });
});

// ─── SanMar Parser ───────────────────────────────────────────────

describe('SanMar EPDD parser (csv-parse)', () => {
  it('parses valid EPDD CSV', async () => {
    const { products } = await parseEPDD(streamFrom(EPDD_VALID_CONTENT));
    expect(products.size).toBe(5);
    expect(products.get('K500-BLK-M')).toMatchObject({
      'STYLE#': 'K500',
      MILL: 'Port Authority',
      CATEGORY_NAME: 'Polos',
      COLOR_NAME: 'Black',
      SIZE: 'M',
    });
  });

  it('handles quote-encapsulated fields with escaped quotes', async () => {
    const { products } = await parseEPDD(streamFrom(EPDD_WITH_QUOTES));
    expect(products.size).toBe(1);
    const product = products.get('K500-BLK-M')!;
    expect(product.PRODUCT_TITLE).toBe('Silk Touch "Premium" Polo');
  });

  it('handles multiline quoted descriptions', async () => {
    const multilineEPDD = `${EPDD_HEADERS}
"K500-BLK-M","Silk Touch Polo","A polo with
multiple lines in the
description field","K500","Polos","Black","M","12.50","","INV001","S01","Port Authority","Active","https://cdn.example.com/k500.jpg"
`;
    const { products } = await parseEPDD(streamFrom(multilineEPDD));
    expect(products.size).toBe(1);
    const product = products.get('K500-BLK-M')!;
    expect(product.PRODUCT_DESCRIPTION).toContain('multiple lines');
    expect(product.PRODUCT_DESCRIPTION).toContain('\n');
  });

  it('canonicalizes mixed-case headers', async () => {
    const mixedCaseEPDD = `"Unique_Key","Product_Title","Product_Description","Style#","Category_Name","Color_Name","Size","Piece_Price","Case_Price","Inventory_Key","Size_Index","Mill","Product_Status","Product_Image"
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","12.50","","INV001","S01","Port Authority","Active","https://cdn.example.com/k500.jpg"
`;
    const { products } = await parseEPDD(streamFrom(mixedCaseEPDD));
    expect(products.size).toBe(1);
    expect(products.get('K500-BLK-M')!['STYLE#']).toBe('K500');
  });

  it('accepts documented image URL aliases', async () => {
    const epdd = `"UNIQUE_KEY","PRODUCT_TITLE","PRODUCT_DESCRIPTION","STYLE#","CATEGORY_NAME","COLOR_NAME","SIZE","PIECE_PRICE","CASE_PRICE","INVENTORY_KEY","SIZE_INDEX","MILL","PRODUCT_STATUS","PRODUCT_IMAGE_URL"
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","12.50","","INV001","S01","Port Authority","Active","https://cdn.example.com/k500.jpg"
`;
    const { products } = await parseEPDD(streamFrom(epdd));
    expect(products.get('K500-BLK-M')!.PRODUCT_IMAGE).toBe('https://cdn.example.com/k500.jpg');
  });

  it('rejects missing required headers', async () => {
    await expect(parseEPDD(streamFrom(EPDD_MISSING_HEADERS))).rejects.toThrow(
      /missing required headers/i
    );
  });

  it('rejects empty file', async () => {
    await expect(parseEPDD(streamFrom(EPDD_EMPTY))).rejects.toThrow(/empty/i);
  });

  it('fails on duplicate-conflicting identities', async () => {
    await expect(parseEPDD(streamFrom(EPDD_DUPLICATE_CONFLICTING))).rejects.toThrow(
      /conflicting identity/i
    );
  });

  it('merges compatible duplicate unique keys from multiple categories deterministically', async () => {
    const { products } = await parseEPDD(streamFrom(EPDD_DUPLICATE_CATEGORY_MERGE));
    expect(products.size).toBe(1);
    expect(products.get('K500-BLK-M')!.CATEGORY_NAME).toBe('Polos; Uniforms');
  });

  it('enforces EPDD unique-key memory cap', async () => {
    await expect(
      parseEPDD(streamFrom(EPDD_VALID_CONTENT), { maxUniqueKeys: 1 } as any)
    ).rejects.toThrow(/unique key cap/i);
  });

  it('counts malformed rows', async () => {
    // Rows with missing UNIQUE_KEY are counted as malformed
    const epddWithMalformed = `${EPDD_HEADERS}
"K500-BLK-M","Good Row","","K500","Polos","Black","M","12.50","","INV001","S01","Port Authority","Active",""
"","Missing Key","","K500","Polos","Black","L","12.50","","INV002","S02","Port Authority","Active",""
`;
    const { products, malformedCount } = await parseEPDD(streamFrom(epddWithMalformed));
    expect(products.size).toBe(1);
    expect(malformedCount).toBe(1);
  });
});

describe('SanMar DIP parser', () => {
  const snapshotTime = new Date('2026-08-22T12:00:00Z');

  it('parses valid DIP and aggregates warehouse inventory', async () => {
    const { records } = await parseDIP(streamFrom(DIP_VALID_CONTENT), snapshotTime);
    expect(records.size).toBe(5);

    const k500blkm = records.get('K500-BLK-M')!;
    expect(k500blkm.total_qty).toBe(40);
    expect(k500blkm.warehouses).toHaveLength(2);
  });

  it('uses sale price only when sale dates include snapshot', async () => {
    const { records } = await parseDIP(streamFrom(DIP_VALID_CONTENT), snapshotTime);

    const active = records.get('K500-BLK-M')!;
    expect(active.sale_price).toBe(9.50);

    const expired = records.get('K500-BLK-L')!;
    expect(expired.sale_price).toBeUndefined();
  });

  it('does not use sale price when sale is expired', async () => {
    const { records } = await parseDIP(streamFrom(DIP_EXPIRED_SALE), snapshotTime);
    const rec = records.get('K500-BLK-M')!;
    expect(rec.sale_price).toBeUndefined();
  });

  it('does not use sale price when sale is in the future', async () => {
    const { records } = await parseDIP(streamFrom(DIP_FUTURE_SALE), snapshotTime);
    const rec = records.get('K500-BLK-M')!;
    expect(rec.sale_price).toBeUndefined();
  });

  it('preserves zero inventory', async () => {
    const { records } = await parseDIP(streamFrom(DIP_ZERO_INVENTORY), snapshotTime);
    const rec = records.get('K500-BLK-M')!;
    expect(rec.total_qty).toBe(0);
  });

  it('marks discontinued from discontinued_code', async () => {
    const { records } = await parseDIP(streamFrom(DIP_DISCONTINUED), snapshotTime);
    const rec = records.get('K500-BLK-M')!;
    expect(rec.discontinued).toBe(true);
  });

  it('does not treat legacy D code as official discontinued status', async () => {
    const dip = `${DIP_HEADERS}
INV005|S05|PC61|Navy|L|WH1|80|4.50|54.00|4.25||9.50|2026-01-01|2026-12-31|PC61-NVY-L|D
`;
    const { records } = await parseDIP(streamFrom(dip), snapshotTime);
    const pc61l = records.get('PC61-NVY-L')!;
    expect(pc61l.discontinued).toBe(false);
    expect(pc61l.discontinued_code).toBe('D');
  });

  it('marks official S/M discontinued codes case-insensitively', async () => {
    const { records } = await parseDIP(streamFrom(DIP_VALID_CONTENT), snapshotTime);
    const pc61l = records.get('PC61-NVY-L')!;
    expect(pc61l.discontinued).toBe(true);
    expect(pc61l.discontinued_code).toBe('m');
  });

  it('rejects missing required headers', async () => {
    await expect(parseDIP(streamFrom(DIP_MISSING_HEADERS), snapshotTime)).rejects.toThrow(
      /missing required headers/i
    );
  });

  it('rejects empty file', async () => {
    await expect(parseDIP(streamFrom(DIP_EMPTY), snapshotTime)).rejects.toThrow(/empty/i);
  });

  it('fails on duplicate-conflicting identities', async () => {
    await expect(parseDIP(streamFrom(DIP_DUPLICATE_CONFLICTING), snapshotTime)).rejects.toThrow(
      /conflicting identity/i
    );
  });

  it('requires valid snapshotTime', async () => {
    await expect(parseDIP(streamFrom(DIP_VALID_CONTENT), 'not-a-date' as any)).rejects.toThrow(
      /valid Date/i
    );
  });

  it('counts malformed DIP rows', async () => {
    const dipWithMalformed = `${DIP_HEADERS}
INV001|S01|K500|Black|M|WH1|25|11.00|132.00|9.25||9.50|2026-01-01|2026-12-31|K500-BLK-M|
short|row
`;
    const { records, malformedCount } = await parseDIP(streamFrom(dipWithMalformed), snapshotTime);
    expect(records.size).toBe(1);
    expect(malformedCount).toBe(1);
  });

  it.each([
    ['trailing price characters', '5|12.50USD'],
    ['trailing quantity characters', '5x|12.50'],
    ['whitespace-only quantity', '   |12.50'],
    ['negative quantity', '-1|12.50'],
    ['negative price', '5|-12.50'],
    ['non-finite price', '5|Infinity'],
  ])('counts %s as malformed instead of partially parsing it', async (_label, numericFields) => {
    const dip = `${DIP_HEADERS}
INV001|S01|K500|Black|M|WH1|25|11.00|132.00|9.25|||||K500-BLK-M|
INV002|S02|K500|Black|L|WH1|${numericFields}|132.00|9.25|||||K500-BLK-L|
`;
    const { records, malformedCount } = await parseDIP(streamFrom(dip), snapshotTime);
    expect(records.size).toBe(1);
    expect(malformedCount).toBe(1);
  });

  it('enforces DIP unique-key and warehouse memory caps', async () => {
    await expect(
      parseDIP(streamFrom(DIP_VALID_CONTENT), snapshotTime, { maxUniqueKeys: 1 } as any)
    ).rejects.toThrow(/unique key cap/i);

    await expect(
      parseDIP(streamFrom(DIP_VALID_CONTENT), snapshotTime, { maxWarehousesPerKey: 1 } as any)
    ).rejects.toThrow(/warehouse cap/i);
  });
});

describe('SanMar EPDD+DIP join', () => {
  const snapshotTime = new Date('2026-08-22T12:00:00Z');

  it('joins EPDD and DIP by unique_key', async () => {
    const { products: epdd } = await parseEPDD(streamFrom(EPDD_VALID_CONTENT));
    const { records: dip } = await parseDIP(streamFrom(DIP_VALID_CONTENT), snapshotTime);
    const result = await joinEPDDAndDIP(epdd, dip);

    expect(result.styles).toHaveLength(2); // K500, PC61
    expect(result.variantCount).toBe(5);
    expect(result.skippedCount).toBe(0);
  });

  it('resolves SanMar local DIP cost from casePrice even when an active sale is lower', async () => {
    const epdd = `${EPDD_HEADERS}
"BC3001-AQUA-XS","Jersey Tee","Soft tee","BC3001","T-Shirts","Aqua","XS","5.54","4.38","INV101","S01","Bella + Canvas","Active",""
`;
    const dipWithActiveSale = `${DIP_HEADERS}
INV101|S01|BC3001|Aqua|XS|WH1|12|5.54|60.00|4.38|72|3.99|2026-01-01|2026-12-31|BC3001-AQUA-XS|
`;
    const { products } = await parseEPDD(streamFrom(epdd));
    const { records } = await parseDIP(streamFrom(dipWithActiveSale), snapshotTime);

    const variants: any[] = [];
    await joinEPDDAndDIP(products, records, {
      onVariant: (v: any) => { variants.push(v); },
    });

    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({
      piecePrice: 5.54,
      casePrice: 4.38,
      salePrice: 3.99,
      resolvedCost: 4.38,
      costBasis: 'casePrice',
    });
  });

  it('marks local SanMar rows unpriced when casePrice is missing or zero', async () => {
    const epdd = `${EPDD_HEADERS}
"BC3001-AQUA-XS","Jersey Tee","Soft tee","BC3001","T-Shirts","Aqua","XS","5.54","","INV101","S01","Bella + Canvas","Active",""
"BC3001-AQUA-S","Jersey Tee","Soft tee","BC3001","T-Shirts","Aqua","S","5.54","0","INV102","S02","Bella + Canvas","Active",""
`;
    const dip = `${DIP_HEADERS}
INV101|S01|BC3001|Aqua|XS|WH1|12|5.54|60.00||72|3.99|2026-01-01|2026-12-31|BC3001-AQUA-XS|
INV102|S02|BC3001|Aqua|S|WH1|12|5.54|60.00|0|72||2026-01-01|2026-12-31|BC3001-AQUA-S|
`;
    const { products } = await parseEPDD(streamFrom(epdd));
    const { records } = await parseDIP(streamFrom(dip), snapshotTime);

    const variants: any[] = [];
    const result = await joinEPDDAndDIP(products, records, {
      onVariant: (v: any) => { variants.push(v); },
    });

    expect(variants).toHaveLength(0);
    expect(result.variantCount).toBe(0);
    expect(result.skippedCount).toBe(2);
  });

  it('preserves active DIP sale price while resolving cost from casePrice', async () => {
    const { products: epdd } = await parseEPDD(streamFrom(EPDD_VALID_CONTENT));
    const { records: dip } = await parseDIP(streamFrom(DIP_VALID_CONTENT), snapshotTime);

    const variants: any[] = [];
    await joinEPDDAndDIP(epdd, dip, {
      onVariant: (v: any) => { variants.push(v); },
    });

    const k500blkm = variants.find((v: any) => v.sourceVariantId === 'K500-BLK-M');
    expect(k500blkm?.salePrice).toBe(9.50);
    expect(k500blkm?.resolvedCost).toBe(9.25);
    expect(k500blkm?.costBasis).toBe('casePrice');
  });

  it('uses casePrice when there is no active sale', async () => {
    const { products: epdd } = await parseEPDD(streamFrom(EPDD_VALID_CONTENT));
    const { records: dip } = await parseDIP(streamFrom(DIP_VALID_CONTENT), snapshotTime);

    const variants: any[] = [];
    await joinEPDDAndDIP(epdd, dip, {
      onVariant: (v: any) => { variants.push(v); },
    });

    const k500blkl = variants.find((v: any) => v.sourceVariantId === 'K500-BLK-L');
    expect(k500blkl?.resolvedCost).toBe(9.25);
    expect(k500blkl?.costBasis).toBe('casePrice');
  });

  it('resolves from EPDD CASE_PRICE when DIP is missing and fallback is enabled', async () => {
    const epdd = `${EPDD_HEADERS}
"BC3001-AQUA-XS","Jersey Tee","Soft tee","BC3001","T-Shirts","Aqua","XS","5.54","4.38","INV101","S01","Bella + Canvas","Active",""
`;
    const dipHeadersOnly = `${DIP_HEADERS}
`;
    const { products } = await parseEPDD(streamFrom(epdd));
    const { records } = await parseDIP(streamFrom(dipHeadersOnly), snapshotTime);

    const variants: any[] = [];
    await joinEPDDAndDIP(products, records, {
      allowEpddPriceFallbackMissingDip: true,
      onVariant: (v: any) => { variants.push(v); },
    });

    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({
      piecePrice: 5.54,
      casePrice: 4.38,
      resolvedCost: 4.38,
      costBasis: 'casePrice',
    });
  });

  it('skips EPDD fallback rows when CASE_PRICE is missing even if PIECE_PRICE is present', async () => {
    const epdd = `${EPDD_HEADERS}
"BC3001-AQUA-XS","Jersey Tee","Soft tee","BC3001","T-Shirts","Aqua","XS","5.54","","INV101","S01","Bella + Canvas","Active",""
`;
    const dipHeadersOnly = `${DIP_HEADERS}
`;
    const { products } = await parseEPDD(streamFrom(epdd));
    const { records } = await parseDIP(streamFrom(dipHeadersOnly), snapshotTime);

    const variants: any[] = [];
    const result = await joinEPDDAndDIP(products, records, {
      allowEpddPriceFallbackMissingDip: true,
      onVariant: (v: any) => { variants.push(v); },
    });

    expect(variants).toHaveLength(0);
    expect(result.skippedCount).toBe(1);
  });

  it('uses DIP inventory aggregated across warehouses', async () => {
    const { products: epdd } = await parseEPDD(streamFrom(EPDD_VALID_CONTENT));
    const { records: dip } = await parseDIP(streamFrom(DIP_VALID_CONTENT), snapshotTime);

    const variants: any[] = [];
    await joinEPDDAndDIP(epdd, dip, {
      onVariant: (v: any) => { variants.push(v); },
    });

    const k500blkm = variants.find((v: any) => v.sourceVariantId === 'K500-BLK-M');
    expect(k500blkm?.inventoryQty).toBe(40);
  });

  it('preserves zero inventory', async () => {
    const { products: epdd } = await parseEPDD(streamFrom(EPDD_VALID_CONTENT));
    const { records: dip } = await parseDIP(streamFrom(DIP_VALID_CONTENT), snapshotTime);

    const variants: any[] = [];
    await joinEPDDAndDIP(epdd, dip, {
      onVariant: (v: any) => { variants.push(v); },
    });

    const k500reds = variants.find((v: any) => v.sourceVariantId === 'K500-RED-S');
    expect(k500reds?.inventoryQty).toBe(0);
  });

  it('marks discontinued variants from DIP', async () => {
    const { products: epdd } = await parseEPDD(streamFrom(EPDD_VALID_CONTENT));
    const { records: dip } = await parseDIP(streamFrom(DIP_VALID_CONTENT), snapshotTime);

    const variants: any[] = [];
    await joinEPDDAndDIP(epdd, dip, {
      onVariant: (v: any) => { variants.push(v); },
    });

    const pc61l = variants.find((v: any) => v.sourceVariantId === 'PC61-NVY-L');
    expect(pc61l?.discontinued).toBe(true);
  });

  it('streams variants via callbacks without materializing array', async () => {
    const { products: epdd } = await parseEPDD(streamFrom(EPDD_VALID_CONTENT));
    const { records: dip } = await parseDIP(streamFrom(DIP_VALID_CONTENT), snapshotTime);

    const styles: any[] = [];
    const variants: any[] = [];
    const result = await joinEPDDAndDIP(epdd, dip, {
      onStyle: (s: any) => { styles.push(s); },
      onVariant: (v: any) => { variants.push(v); },
    });

    expect(styles).toHaveLength(result.styleCount);
    expect(variants).toHaveLength(result.variantCount);
  });
});

describe('SanMar full ingestion', () => {
  it('yields completeness manifest', async () => {
    const styles: any[] = [];
    const variants: any[] = [];

    const manifest = await ingestSanMar({
      epddSource: streamFrom(EPDD_VALID_CONTENT),
      dipSource: streamFrom(DIP_VALID_CONTENT),
      snapshotTime: new Date('2026-08-22T12:00:00Z'),
      onStyle: (s: any) => { styles.push(s); },
      onVariant: (v: any) => { variants.push(v); },
    });

    expect(manifest.vendor).toBe('sanmar');
    expect(manifest.styleCount).toBe(2);
    expect(manifest.variantCount).toBe(5);
    expect(manifest.contentHash).toBeTruthy();
    expect(manifest.source).toBe('sanmar-epdd-dip');
    expect(manifest.complete).toBe(true);
    expect(manifest.sourceErrors).toBe(0);
    expect(styles).toHaveLength(2);
    expect(variants).toHaveLength(5);
  });

  it('refuses activation when one valid SanMar row is accompanied by one skipped invalid row', async () => {
    const epdd = `${EPDD_HEADERS}
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","12.50","","INV001","S01","Port Authority","Active",""
"K500-BLK-L","Unpriced Variant","Classic polo","K500","Polos","Black","L","12.50","","INV002","S02","Port Authority","Active",""
`;
    const dip = `${DIP_HEADERS}
INV001|S01|K500|Black|M|WH1|25|11.00|132.00|9.25|||||K500-BLK-M|
INV002|S02|K500|Black|L|WH1|30||||||||K500-BLK-L|
`;
    const manifest = await ingestSanMar({
      epddSource: streamFrom(epdd),
      dipSource: streamFrom(dip),
      snapshotTime: new Date('2026-08-22T12:00:00Z'),
      onStyle: () => {},
      onVariant: () => {},
    });

    expect(manifest.variantCount).toBe(1);
    expect(manifest.skippedCount).toBe(1);
    expect(manifest.complete).toBe(false);
    expect(manifest.sourceErrors).toBe(1);
    expect(manifest.reasons).toContainEqual({ code: 'invalid_source_rows', count: 1 });
    expect(() => assertManifestCompleteForActivation(manifest)).toThrow(/refusing activation/i);
  });

  it('marks manifest incomplete when any EPDD or DIP row is malformed', async () => {
    const epddWithMalformed = `${EPDD_HEADERS}
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","12.50","","INV001","S01","Port Authority","Active",""
"","Missing Key","","K500","Polos","Black","L","12.50","","INV002","S02","Port Authority","Active",""
`;
    const manifest = await ingestSanMar({
      epddSource: streamFrom(epddWithMalformed),
      dipSource: streamFrom(DIP_VALID_CONTENT),
      snapshotTime: new Date('2026-08-22T12:00:00Z'),
      onStyle: () => {},
      onVariant: () => {},
    });
    expect(manifest.complete).toBe(false);
    expect(manifest.sourceErrors).toBe(5);
    expect(manifest.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'malformed_rows', count: 1 }),
        expect.objectContaining({ code: 'dip_keys_missing_epdd', count: 4 }),
      ])
    );
  });

  it('marks manifest incomplete when an EPDD key is missing from DIP', async () => {
    const dipMissingOneKey = `${DIP_HEADERS}
INV001|S01|K500|Black|M|WH1|25|11.00|132.00|9.25|||||K500-BLK-M|
INV002|S02|K500|Black|L|WH1|30|11.00|132.00|9.25|||||K500-BLK-L|
INV003|S03|K500|Red|S|WH1|0|11.00|132.00|9.25|||||K500-RED-S|
INV004|S04|PC61|Navy|M|WH1|100|4.50|54.00|4.25|||||PC61-NVY-M|
`;

    const manifest = await ingestSanMar({
      epddSource: streamFrom(EPDD_VALID_CONTENT),
      dipSource: streamFrom(dipMissingOneKey),
      snapshotTime: new Date('2026-08-22T12:00:00Z'),
      onStyle: () => {},
      onVariant: () => {},
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.sourceErrors).toBe(1);
    expect(manifest.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'epdd_keys_missing_dip', count: 1 }),
      ])
    );
  });

  it('marks manifest incomplete when DIP has an extra key missing from EPDD', async () => {
    const dipWithExtraKey = `${DIP_VALID_CONTENT}INV999|S99|EXTRA|Purple|M|WH1|1|8.00|96.00||||||EXTRA-PUR-M|
`;

    const manifest = await ingestSanMar({
      epddSource: streamFrom(EPDD_VALID_CONTENT),
      dipSource: streamFrom(dipWithExtraKey),
      snapshotTime: new Date('2026-08-22T12:00:00Z'),
      onStyle: () => {},
      onVariant: () => {},
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.sourceErrors).toBe(1);
    expect(manifest.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'dip_keys_missing_epdd', count: 1 }),
      ])
    );
  });

  it('orchestration refuses activation for incomplete manifests', () => {
    try {
      assertManifestCompleteForActivation({
        vendor: 'sanmar',
        styleCount: 1,
        variantCount: 1,
        skippedCount: 1,
        sourceErrors: 1,
        complete: false,
        reasons: [{ code: 'missing_data', styleId: 'K500', rawProductCount: 0, usableVariantCount: 0 }],
        contentHash: 'hash',
        source: 'sanmar-epdd-dip',
      });
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.message).toContain('refusing activation');
      expect(error.message).toContain('K500');
      expect(error.message).toContain('rawProductCount');
    }
  });

  it('cancellation aborts SanMar parsing promptly', async () => {
    let callCount = 0;

    await expect(
      ingestSanMar({
        epddSource: streamFrom(EPDD_VALID_CONTENT),
        dipSource: streamFrom(DIP_VALID_CONTENT),
        snapshotTime: new Date('2026-08-22T12:00:00Z'),
        onStyle: () => {},
        onVariant: () => {},
        shouldContinue: async () => {
          callCount++;
          return callCount <= 1; // Allow EPDD parse, cancel before DIP
        },
      })
    ).rejects.toThrow(/canceled/i);
  });

  it('EPDD fallback: CASE_PRICE 0 yields incomplete manifest with sourceErrors > 0', async () => {
    const epdd = `${EPDD_HEADERS}
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","12.50","0","INV001","S01","Port Authority","Active",""
`;
    const dipEmpty = `${DIP_HEADERS}
`;
    const manifest = await ingestSanMar({
      epddSource: streamFrom(epdd),
      dipSource: streamFrom(dipEmpty),
      snapshotTime: new Date('2026-08-22T12:00:00Z'),
      onStyle: () => {},
      onVariant: () => {},
      allowEpddPriceFallbackMissingDip: true,
    });

    expect(manifest.variantCount).toBe(0);
    expect(manifest.complete).toBe(false);
    expect(manifest.sourceErrors).toBeGreaterThan(0);
    expect(() => assertManifestCompleteForActivation(manifest)).toThrow(/refusing activation/i);
  });

  it('EPDD fallback: CASE_PRICE -1 yields incomplete manifest with sourceErrors > 0', async () => {
    const epdd = `${EPDD_HEADERS}
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","12.50","-1","INV001","S01","Port Authority","Active",""
`;
    const dipEmpty = `${DIP_HEADERS}
`;
    const manifest = await ingestSanMar({
      epddSource: streamFrom(epdd),
      dipSource: streamFrom(dipEmpty),
      snapshotTime: new Date('2026-08-22T12:00:00Z'),
      onStyle: () => {},
      onVariant: () => {},
      allowEpddPriceFallbackMissingDip: true,
    });

    expect(manifest.variantCount).toBe(0);
    expect(manifest.complete).toBe(false);
    expect(manifest.sourceErrors).toBeGreaterThan(0);
    expect(() => assertManifestCompleteForActivation(manifest)).toThrow(/refusing activation/i);
  });

  it('EPDD fallback: malformed CASE_PRICE "USD 4.38" yields incomplete manifest with sourceErrors > 0', async () => {
    const epdd = `${EPDD_HEADERS}
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","12.50","USD 4.38","INV001","S01","Port Authority","Active",""
`;
    const dipEmpty = `${DIP_HEADERS}
`;
    const manifest = await ingestSanMar({
      epddSource: streamFrom(epdd),
      dipSource: streamFrom(dipEmpty),
      snapshotTime: new Date('2026-08-22T12:00:00Z'),
      onStyle: () => {},
      onVariant: () => {},
      allowEpddPriceFallbackMissingDip: true,
    });

    expect(manifest.variantCount).toBe(0);
    expect(manifest.complete).toBe(false);
    expect(manifest.sourceErrors).toBeGreaterThan(0);
    expect(() => assertManifestCompleteForActivation(manifest)).toThrow(/refusing activation/i);
  });
});

describe('SanMar SDL_N no-inventory ingestion', () => {
  it('normalizes valid SDL_N rows with case-price cost basis and source hash provenance', async () => {
    const styles: any[] = [];
    const variants: any[] = [];
    const expectedHash = sha256(SDLN_VALID_CONTENT);

    const manifest = await withTempSDLN(SDLN_VALID_CONTENT, async ({ path }) => ingestSanMarSDLN({
      source: path,
      snapshotTime: new Date('2026-08-22T12:00:00Z'),
      expectedSourceSha256: expectedHash,
      onStyle: (style: any) => { styles.push(style); },
      onVariant: (variant: any) => { variants.push(variant); },
    }));

    expect(manifest.sourceHash).toBe(expectedHash);
    expect(manifest.sourceSha256).toBe(expectedHash);
    expect(manifest).toMatchObject({
      vendor: 'sanmar',
      styleCount: 2,
      variantCount: 3,
      skippedCount: 0,
      sourceErrors: 0,
      complete: true,
      source: 'sanmar-sdln',
    });
    expect(styles.map((style) => style.sourceStyleId)).toEqual(['K500', 'PC61']);
    expect(variants[0]).toMatchObject({
      sourceVariantId: 'K500-BLK-M',
      sourceStyleId: 'K500',
      styleCode: 'K500',
      color: 'Black',
      size: 'M',
      sizeOrder: 1,
      discontinued: false,
      piecePrice: 11,
      dozenPrice: 10,
      casePrice: 9.25,
      resolvedCost: 9.25,
      costBasis: 'casePrice',
    });
    expect(variants[0].inventoryQty).toBeUndefined();
    expect(variants[0].salePrice).toBeUndefined();
    expect(variants[0].customerPrice).toBeUndefined();
  });

  it('maps selectable and unavailable SDL_N lifecycle statuses explicitly', async () => {
    const variants: any[] = [];

    await withTempSDLN(SDLN_STATUS_CONTENT, async ({ path, expectedSourceSha256 }) => ingestSanMarSDLN({
      source: path,
      expectedSourceSha256,
      onStyle: () => {},
      onVariant: (variant: any) => { variants.push(variant); },
    }));

    expect(variants.map((variant) => variant.discontinued)).toEqual([false, true, true, true]);
  });

  it('rejects missing required SDL_N headers', async () => {
    await withTempSDLN(SDLN_MISSING_HEADERS, async ({ path, expectedSourceSha256 }) => {
      await expect(ingestSanMarSDLN({
        source: path,
        expectedSourceSha256,
        onStyle: () => {},
        onVariant: () => {},
      })).rejects.toThrow(/missing required headers/i);
    });
  });

  it('rejects duplicate canonical SDL_N headers before row mapping', async () => {
    const onStyle = vi.fn();
    const onVariant = vi.fn();

    await withTempSDLN(SDLN_DUPLICATE_CASE_PRICE_HEADER, async ({ path, expectedSourceSha256 }) => {
      await expect(ingestSanMarSDLN({
        source: path,
        expectedSourceSha256,
        onStyle,
        onVariant,
      })).rejects.toThrow(/duplicate headers: CASE_PRICE/i);
    });
    await withTempSDLN(SDLN_DUPLICATE_CANONICAL_ALIAS_HEADER, async ({ path, expectedSourceSha256 }) => {
      await expect(ingestSanMarSDLN({
        source: path,
        expectedSourceSha256,
        onStyle,
        onVariant,
      })).rejects.toThrow(/duplicate headers: PRODUCT_IMAGE/i);
    });
    expect(onStyle).not.toHaveBeenCalled();
    expect(onVariant).not.toHaveBeenCalled();
  });

  it('rejects unknown or blank SDL_N product status', async () => {
    await withTempSDLN(SDLN_UNKNOWN_STATUS, async ({ path, expectedSourceSha256 }) => {
      await expect(ingestSanMarSDLN({
        source: path,
        expectedSourceSha256,
        onStyle: () => {},
        onVariant: () => {},
      })).rejects.toThrow(/PRODUCT_STATUS/i);
    });
  });

  it('rejects SDL_N rows with missing unique key or style', async () => {
    const missingKey = SDLN_VALID_CONTENT.replace('"K500-BLK-M"', '""');
    const missingStyle = SDLN_VALID_CONTENT.replace('"K500","Polos"', '"","Polos"');

    await withTempSDLN(missingKey, async ({ path, expectedSourceSha256 }) => {
      await expect(ingestSanMarSDLN({
        source: path,
        expectedSourceSha256,
        onStyle: () => {},
        onVariant: () => {},
      })).rejects.toThrow(/UNIQUE_KEY/i);
    });
    await withTempSDLN(missingStyle, async ({ path, expectedSourceSha256 }) => {
      await expect(ingestSanMarSDLN({
        source: path,
        expectedSourceSha256,
        onStyle: () => {},
        onVariant: () => {},
      })).rejects.toThrow(/STYLE#/i);
    });
  });

  it('rejects malformed, missing, zero, or negative SDL_N case prices', async () => {
    const missingCasePrice = SDLN_MALFORMED_CASE_PRICE.replace('"USD 9.25"', '""');
    const negativeCasePrice = SDLN_MALFORMED_CASE_PRICE.replace('"USD 9.25"', '"-1"');

    for (const content of [
      SDLN_MALFORMED_CASE_PRICE,
      missingCasePrice,
      SDLN_ZERO_CASE_PRICE,
      negativeCasePrice,
    ]) {
      await withTempSDLN(content, async ({ path, expectedSourceSha256 }) => {
        await expect(ingestSanMarSDLN({
          source: path,
          expectedSourceSha256,
          onStyle: () => {},
          onVariant: () => {},
        })).rejects.toThrow(/CASE_PRICE/i);
      });
    }
  });

  it('rejects duplicate conflicting SDL_N unique keys', async () => {
    await withTempSDLN(SDLN_DUPLICATE_CONFLICTING, async ({ path, expectedSourceSha256 }) => {
      await expect(ingestSanMarSDLN({
        source: path,
        expectedSourceSha256,
        onStyle: () => {},
        onVariant: () => {},
      })).rejects.toThrow(/duplicate UNIQUE_KEY/i);
    });
  });

  it('rejects duplicate identical SDL_N unique key rows', async () => {
    await withTempSDLN(SDLN_DUPLICATE_IDENTICAL, async ({ path, expectedSourceSha256 }) => {
      await expect(ingestSanMarSDLN({
        source: path,
        expectedSourceSha256,
        onStyle: () => {},
        onVariant: () => {},
      })).rejects.toThrow(/duplicate UNIQUE_KEY/i);
    });
  });

  it('rejects malformed SDL_N CSV rows with strict quote handling', async () => {
    await withTempSDLN(SDLN_MALFORMED_CSV, async ({ path, expectedSourceSha256 }) => {
      await expect(ingestSanMarSDLN({
        source: path,
        expectedSourceSha256,
        onStyle: () => {},
        onVariant: () => {},
      })).rejects.toThrow(/CSV parse error/i);
    });
  });

  it('rejects SDL_N expected source hash mismatches', async () => {
    await withTempSDLN(SDLN_VALID_CONTENT, async ({ path }) => {
      await expect(ingestSanMarSDLN({
        source: path,
        expectedSourceSha256: '0'.repeat(64),
        onStyle: () => {},
        onVariant: () => {},
      })).rejects.toThrow(/SHA-256 mismatch/i);
    });
  });

  it('rejects SDL_N stream sources before invoking callbacks', async () => {
    const onStyle = vi.fn();
    const onVariant = vi.fn();
    const shouldContinue = vi.fn();

    await expect(
      ingestSanMarSDLN({
        source: streamFromExact(SDLN_VALID_CONTENT),
        expectedSourceSha256: sha256(SDLN_VALID_CONTENT),
        onStyle,
        onVariant,
        shouldContinue,
      } as any)
    ).rejects.toThrow(/nonempty file path string/i);
    expect(shouldContinue).not.toHaveBeenCalled();
    expect(onStyle).not.toHaveBeenCalled();
    expect(onVariant).not.toHaveBeenCalled();
  });

  it('rejects empty SDL_N source paths before invoking callbacks', async () => {
    const onStyle = vi.fn();
    const onVariant = vi.fn();
    const shouldContinue = vi.fn();

    await expect(
      ingestSanMarSDLN({
        source: '   ',
        expectedSourceSha256: sha256(SDLN_VALID_CONTENT),
        onStyle,
        onVariant,
        shouldContinue,
      })
    ).rejects.toThrow(/nonempty file path string/i);
    expect(shouldContinue).not.toHaveBeenCalled();
    expect(onStyle).not.toHaveBeenCalled();
    expect(onVariant).not.toHaveBeenCalled();
  });

  it('rejects SDL_N ingestion when expectedSourceSha256 is missing', async () => {
    const onStyle = vi.fn();
    const onVariant = vi.fn();

    await withTempSDLN(SDLN_VALID_CONTENT, async ({ path }) => {
      await expect(ingestSanMarSDLN({
        source: path,
        onStyle,
        onVariant,
      } as any)).rejects.toThrow(/expectedSourceSha256 is required/i);
    });
    expect(onStyle).not.toHaveBeenCalled();
    expect(onVariant).not.toHaveBeenCalled();
  });

  it('rejects malformed SDL_N expected source hashes before parsing rows', async () => {
    const onStyle = vi.fn();
    const onVariant = vi.fn();

    await withTempSDLN(SDLN_VALID_CONTENT, async ({ path }) => {
      await expect(ingestSanMarSDLN({
        source: path,
        expectedSourceSha256: 'not-a-sha',
        onStyle,
        onVariant,
      })).rejects.toThrow(/64-character SHA-256 hex digest/i);
    });
    expect(onStyle).not.toHaveBeenCalled();
    expect(onVariant).not.toHaveBeenCalled();
  });

  it('rejects path-based SDL_N hash mismatches before emitting rows', async () => {
    const file = writeTempSDLN(SDLN_VALID_CONTENT);
    const onStyle = vi.fn();
    const onVariant = vi.fn();

    try {
      await expect(
        ingestSanMarSDLN({
          source: file.path,
          expectedSourceSha256: '0'.repeat(64),
          onStyle,
          onVariant,
        })
      ).rejects.toThrow(/SHA-256 mismatch/i);
      expect(onStyle).not.toHaveBeenCalled();
      expect(onVariant).not.toHaveBeenCalled();
    } finally {
      rmSync(file.dir, { recursive: true, force: true });
    }
  });

  it('exports a dry-run SDL_N ingestion function and wires CLI source mode without DIP', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/sync-vendor-catalog.mjs'),
      'utf8'
    );

    expect(typeof ingestSanMarSDLN).toBe('function');
    expect(source).toContain("type: 'sanmar-sdln'");
    expect(source).toContain('CMP_SANMAR_SDLN_PATH');
    expect(source).toContain('CMP_SANMAR_EXPECTED_SOURCE_SHA256');
    expect(source).toContain('computeFileSha256(sdlnPath)');
  });

  it('fails SDL_N CLI before database setup when expected source hash is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmp-sdln-cli-'));
    const path = join(dir, 'SanMar_SDL_N.csv');
    writeFileSync(path, SDLN_VALID_CONTENT);

    try {
      const result = spawnSync(
        process.execPath,
        [
          'scripts/sync-vendor-catalog.mjs',
          '--vendor',
          'sanmar',
          '--sanmar-source',
          'sdln',
          '--sdln-path',
          path,
          '--target-url',
          'postgres://cmp-invalid-localhost.invalid:5432/cmp',
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CMP_SANMAR_EXPECTED_SOURCE_SHA256: '',
            VENDOR_CATALOG_DATABASE_URL: '',
          },
          encoding: 'utf8',
        }
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--expected-source-sha256 (or CMP_SANMAR_EXPECTED_SOURCE_SHA256) is required for SanMar SDL_N mode.');
      expect(result.stderr).not.toMatch(/ENOTFOUND|ECONNREFUSED|getaddrinfo|password authentication|database/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Schema contract ────────────────────────────────────────────

describe('catalog_ingestion_jobs schema', () => {
  it('schema includes catalog_ingestion_jobs table', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'lib/server/vendor-catalog/postgres-schema.mjs'),
      'utf8'
    );
    expect(source).toContain('CREATE TABLE IF NOT EXISTS catalog_ingestion_jobs');
    expect(source).toContain("status IN ('queued', 'running', 'validating', 'completed', 'rejected', 'canceled')");
    expect(source).toContain('lease_owner TEXT');
    expect(source).toContain('lease_expires_at TIMESTAMPTZ');
    expect(source).toContain('heartbeat_at TIMESTAMPTZ');
    expect(source).toContain('cancel_requested BOOLEAN NOT NULL DEFAULT FALSE');
    expect(source).toContain('checkpoint JSONB');
    expect(source).toContain('attempts INTEGER');
    expect(source).toContain('error_summary TEXT');
    expect(source).toContain('import_id UUID REFERENCES catalog_imports(id)');
  });

  it('enforces one non-terminal job per vendor via unique index', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'lib/server/vendor-catalog/postgres-schema.mjs'),
      'utf8'
    );
    expect(source).toContain('idx_ingestion_jobs_one_active_per_vendor');
    expect(source).toContain("WHERE status IN ('queued', 'running', 'validating')");
  });
});

// ─── Orchestrator behavioral tests ─────────────────────────────

describe('sync-vendor-catalog orchestrator', () => {
  it('never defaults to network (no fetch calls without explicit credentials)', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/sync-vendor-catalog.mjs'),
      'utf8'
    );
    expect(source).toContain('CMP_SS_ACCOUNT_NUMBER');
    expect(source).toContain('CMP_SS_API_KEY');
    expect(source).not.toMatch(/defaultUrl|DEFAULT_URL|fallbackUrl/);
  });

  it('reuses existing activation pattern with advisory lock', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/sync-vendor-catalog.mjs'),
      'utf8'
    );
    expect(source).toContain('pg_advisory_xact_lock');
    expect(source).toContain('cmp-vendor-catalog:');
  });

  it('cleans up staged rows on rejection', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/sync-vendor-catalog.mjs'),
      'utf8'
    );
    expect(source).toContain('DELETE FROM catalog_styles WHERE import_id');
    expect(source).toContain('DELETE FROM catalog_variants WHERE import_id');
  });

  it('redacts error summaries before DB storage and terminal logging', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/sync-vendor-catalog.mjs'),
      'utf8'
    );
    expect(source).toContain('redactErrorSummary');
    expect(source).toContain('console.error(redactErrorSummary(error.message))');
  });

  it('uses per-vendor advisory lock for lease acquisition', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/sync-vendor-catalog.mjs'),
      'utf8'
    );
    expect(source).toContain('cmp-ingestion-lease:');
    expect(source).toContain('pg_advisory_xact_lock');
  });

  it('reclaims stale expired leases before acquiring new job', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/sync-vendor-catalog.mjs'),
      'utf8'
    );
    expect(source).toContain('lease_expires_at < CURRENT_TIMESTAMP');
    expect(source).toContain('Stale lease reclaimed');
  });

  it('guards all job mutations with owner and nonterminal status', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/sync-vendor-catalog.mjs'),
      'utf8'
    );
    expect(source).toContain('guardedJobUpdate');
    expect(source).toContain('lease_owner');
  });

  it('checks cancellation between source batches and DB flushes', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/sync-vendor-catalog.mjs'),
      'utf8'
    );
    expect(source).toContain('shouldContinue');
    expect(source).toContain('cancel_requested');
    expect(source).toContain('hasOwnedActiveLease');
    expect(source).toContain('lease_expires_at > CURRENT_TIMESTAMP');
  });

  it('updates checkpoint after each durable flush', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/sync-vendor-catalog.mjs'),
      'utf8'
    );
    // Should update checkpoint inside flushVariants
    expect(source).toMatch(/flushVariants[\s\S]*?guardedJobUpdate[\s\S]*?checkpoint/);
  });

  it('uses dependency-injected fetch and sleep', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/sync-vendor-catalog.mjs'),
      'utf8'
    );
    expect(source).toContain('fetch: fetchFn');
    expect(source).toContain('sleep: sleepFn');
  });

  it('exports runIngestion for testing', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/sync-vendor-catalog.mjs'),
      'utf8'
    );
    expect(source).toContain('export async function runIngestion');
  });

  it('asserts the S&S piece-price invariant after validation and immediately before activation', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/sync-vendor-catalog.mjs'),
      'utf8'
    );
    expect(source).toMatch(
      /await validateImport\(target, importId, vendor, manifest\.styleCount, manifest\.variantCount\);\s*if \(testHooks\?\.beforeActivation\) await testHooks\.beforeActivation\(\{ jobId, owner, importId \}\);\s*if \(vendor === 'ss'\) \{\s*await assertSSPiecePriceInvariant\(target, importId\);\s*\}\s*\/\/ Activate/
    );
    expect(source).toContain("Delta mode is only supported for sanmar");
  });

  it('supports explicit SanMar SOAP and local-file source configuration', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/sync-vendor-catalog.mjs'),
      'utf8'
    );
    expect(source).toContain('CMP_SANMAR_SOURCE');
    expect(source).toContain('CMP_SANMAR_CUSTOMER_NUMBER');
    expect(source).toContain('CMP_SANMAR_USERNAME');
    expect(source).toContain('CMP_SANMAR_PASSWORD');
    expect(source).toContain('CMP_SANMAR_EPDD_PATH');
    expect(source).toContain('CMP_SANMAR_DIP_PATH');
  });
});

// ─── Public cost isolation regression ────────────────────────────

describe('Public cost isolation', () => {
  it('postgres repository does not expose cost in public variant query', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'lib/server/vendor-catalog/postgres-repository.ts'),
      'utf8'
    );
    const getVariantsBlock = source.slice(
      source.indexOf('getStyleVariants'),
      source.indexOf('resolveVariantCost')
    );
    expect(getVariantsBlock).not.toMatch(/resolved_cost|piece_price|customer_price|sale_price|dozen_price|case_price/);
  });
});

// ─── Error taxonomy ──────────────────────────────────────────────

describe('Error taxonomy', () => {
  it('all categories are frozen/immutable', () => {
    expect(Object.isFrozen(ErrorCategory)).toBe(true);
  });

  it('createSourceError includes category', () => {
    const error = createSourceError(ErrorCategory.AUTH, 'test');
    expect(error.category).toBe('auth');
    expect(error.message).toBe('test');
  });

  it('createSourceError includes redacted URL', () => {
    const error = createSourceError(ErrorCategory.NETWORK, 'fail', {
      url: 'https://user:pass@api.example.com/v2',
    });
    expect(error.url).not.toContain('pass');
  });
});

// ─── Vendo importer marked as legacy ─────────────────────────────

describe('Legacy Vendo importer coexistence', () => {
  it('Vendo importer still exists as rollback tooling', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/import-vendo-catalog-postgres.mjs'),
      'utf8'
    );
    expect(source).toContain('VENDO_POSTGRES_URL');
    expect(source).toContain('importVendor');
  });
});
