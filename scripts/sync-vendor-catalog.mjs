#!/usr/bin/env node
/**
 * Direct vendor catalog sync orchestrator.
 *
 * Standalone CLI/worker — no Next.js API route, no Vercel request execution.
 * Supports S&S API mode plus SanMar SOAP, local file, or SDL_N modes.
 *
 * Usage:
 *   node scripts/sync-vendor-catalog.mjs --vendor ss
 *   node scripts/sync-vendor-catalog.mjs --vendor sanmar \
 *     --epdd-path data/epdd.csv --dip-path data/sanmar_dip.txt
 *   node scripts/sync-vendor-catalog.mjs --vendor sanmar --sanmar-source sdln \
 *     --sdln-path data/SanMar_SDL_N.csv --expected-source-sha256 <csv-sha256>
 *   node scripts/sync-vendor-catalog.mjs --vendor sanmar --sanmar-source soap
 *   node scripts/sync-vendor-catalog.mjs --vendor sanmar --sanmar-source soap --sanmar-mode delta
 *
 * Environment:
 *   CMP_SS_ACCOUNT_NUMBER, CMP_SS_API_KEY  — S&S credentials (worker only)
 *   CMP_SANMAR_SOURCE — required: soap, local, or sdln
 *   CMP_SANMAR_CUSTOMER_NUMBER, CMP_SANMAR_USERNAME, CMP_SANMAR_PASSWORD — SOAP credentials
 *   CMP_SANMAR_EPDD_PATH, CMP_SANMAR_DIP_PATH — SanMar local file paths
 *   CMP_SANMAR_SDLN_PATH, CMP_SANMAR_EXPECTED_SOURCE_SHA256 — SanMar SDL_N path/hash
 *   VENDOR_CATALOG_DATABASE_URL — CMP PostgreSQL target
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import pg from 'pg';
import { VENDOR_CATALOG_POSTGRES_SCHEMA_SQL } from '../lib/server/vendor-catalog/postgres-schema.mjs';
import {
  assertSSPiecePriceInvariant,
  assertSafeCatalogCounts,
  assertSanMarCasePriceInvariant,
  buildParameterizedInsert,
} from './lib/postgres-import-helpers.mjs';
import { createSSSource } from './lib/vendor-sources/ss.mjs';
import { ingestSanMar, ingestSanMarSDLN } from './lib/vendor-sources/sanmar.mjs';
import { createSanMarSoapSource, createSanMarDeltaSource } from './lib/vendor-sources/sanmar-soap.mjs';
import { ErrorCategory, createSourceError, redactErrorSummary } from './lib/vendor-sources/contracts.mjs';
import {
  cloneActiveImport,
  patchClonedStyles,
  recalculateActiveVariantCounts,
  computeCloneContentHash,
  captureActiveImportSnapshot,
  activateDeltaImport,
} from './lib/delta-clone.mjs';

const { Pool } = pg;

const STYLE_COLUMNS = [
  'import_id', 'id', 'vendor', 'source_style_id', 'style_code', 'brand',
  'name', 'category', 'description', 'image_url', 'active_variant_count',
  'source_sync_at',
];
const VARIANT_COLUMNS = [
  'import_id', 'id', 'style_id', 'vendor', 'source_variant_id', 'style_code',
  'color', 'size', 'size_order', 'inventory_qty', 'image_url', 'discontinued',
  'piece_price', 'dozen_price', 'case_price', 'sale_price', 'customer_price',
  'resolved_cost', 'cost_basis', 'source_sync_at',
];

const LEASE_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const HEARTBEAT_INTERVAL_MS = 60 * 1000;  // 1 minute
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_CHECK_INTERVAL_ROWS = 1000;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;

// Non-terminal statuses for job lifecycle
const NON_TERMINAL_STATUSES = ['queued', 'running', 'validating'];

// --- Main entry point (only runs when executed directly) ---

const isDirectExecution = process.argv[1]?.endsWith('sync-vendor-catalog.mjs');

if (isDirectExecution) {
  const args = parseArgs(process.argv.slice(2));
  const vendor = args.vendor;
  const targetUrl = args['target-url'] ?? process.env.VENDOR_CATALOG_DATABASE_URL;
  const batchSize = Number(args['batch-size'] ?? DEFAULT_BATCH_SIZE);

  if (!targetUrl) fail('VENDOR_CATALOG_DATABASE_URL is required.');
  if (!['ss', 'sanmar'].includes(vendor)) fail('--vendor must be ss or sanmar.');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    fail('Batch size must be an integer from 1 through 1000.');
  }

  if (vendor === 'sanmar') {
    const epddPath = args['epdd-path'] ?? process.env.CMP_SANMAR_EPDD_PATH;
    const dipPath = args['dip-path'] ?? process.env.CMP_SANMAR_DIP_PATH;
    const sdlnPath = args['sdln-path'] ?? process.env.CMP_SANMAR_SDLN_PATH;
    const sanmarSource = args['sanmar-source'] ?? process.env.CMP_SANMAR_SOURCE ??
      (sdlnPath ? 'sdln' : (epddPath && dipPath ? 'local' : null));
    if (sanmarSource === 'sdln') {
      const expectedSourceSha256 = args['expected-source-sha256'] ?? process.env.CMP_SANMAR_EXPECTED_SOURCE_SHA256;
      if (!expectedSourceSha256) {
        fail('--expected-source-sha256 (or CMP_SANMAR_EXPECTED_SOURCE_SHA256) is required for SanMar SDL_N mode.');
      }
    }
  }

  const target = new Pool({ connectionString: targetUrl, max: 4 });
  const controller = new AbortController();

  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());

  try {
    await target.query(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL);

    let sourceConfig;
    if (vendor === 'ss') {
      const accountNumber = process.env.CMP_SS_ACCOUNT_NUMBER;
      const apiKey = process.env.CMP_SS_API_KEY;
      if (!accountNumber || !apiKey) {
        fail('CMP_SS_ACCOUNT_NUMBER and CMP_SS_API_KEY are required for S&S.');
      }
      let expectedEmptyStylePins;
      try {
        expectedEmptyStylePins = parseSSEmptyStylePins({
          expectedStyleCount: args['expected-style-count'] ?? process.env.CMP_SS_EXPECTED_STYLE_COUNT,
          expectedVariantCount: args['expected-variant-count'] ?? process.env.CMP_SS_EXPECTED_VARIANT_COUNT,
          expectedEmptyStyleSha256: args['expected-empty-style-sha256'] ?? process.env.CMP_SS_EXPECTED_EMPTY_STYLE_SHA256,
        });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      sourceConfig = {
        type: 'ss-api',
        accountNumber,
        apiKey,
        ...(expectedEmptyStylePins ? { expectedEmptyStylePins } : {}),
      };
    } else {
      const epddPath = args['epdd-path'] ?? process.env.CMP_SANMAR_EPDD_PATH;
      const dipPath = args['dip-path'] ?? process.env.CMP_SANMAR_DIP_PATH;
      const sdlnPath = args['sdln-path'] ?? process.env.CMP_SANMAR_SDLN_PATH;
      const expectedSourceSha256 = args['expected-source-sha256'] ?? process.env.CMP_SANMAR_EXPECTED_SOURCE_SHA256;
      const sanmarSource = args['sanmar-source'] ?? process.env.CMP_SANMAR_SOURCE ??
        (sdlnPath ? 'sdln' : (epddPath && dipPath ? 'local' : null));
      if (!sanmarSource) {
        fail('--sanmar-source (or CMP_SANMAR_SOURCE) is required for SanMar and must be soap, local, or sdln.');
      }
      if (!['soap', 'local', 'sdln'].includes(sanmarSource)) {
        fail('--sanmar-source (or CMP_SANMAR_SOURCE) must be soap, local, or sdln.');
      }
      if (sanmarSource === 'local') {
        if (!epddPath || !dipPath) {
          fail('--epdd-path and --dip-path (or CMP_SANMAR_EPDD_PATH/CMP_SANMAR_DIP_PATH) required for SanMar local mode.');
        }
        sourceConfig = { type: 'sanmar-local', epddPath, dipPath };
      } else if (sanmarSource === 'sdln') {
        if (!sdlnPath) {
          fail('--sdln-path (or CMP_SANMAR_SDLN_PATH) is required for SanMar SDL_N mode.');
        }
        if (!expectedSourceSha256) {
          fail('--expected-source-sha256 (or CMP_SANMAR_EXPECTED_SOURCE_SHA256) is required for SanMar SDL_N mode.');
        }
        if (!/^[a-f0-9]{64}$/i.test(expectedSourceSha256)) {
          fail('--expected-source-sha256 (or CMP_SANMAR_EXPECTED_SOURCE_SHA256) must be a 64-character SHA-256 hex digest.');
        }
        const normalizedExpectedSourceSha256 = expectedSourceSha256.toLowerCase();
        const actualSourceSha256 = await computeFileSha256(sdlnPath);
        if (actualSourceSha256 !== normalizedExpectedSourceSha256) {
          fail(`SanMar SDL_N source SHA-256 mismatch: expected ${normalizedExpectedSourceSha256}, got ${actualSourceSha256}.`);
        }
        sourceConfig = { type: 'sanmar-sdln', sdlnPath, expectedSourceSha256: normalizedExpectedSourceSha256 };
      } else {
        const sanmarMode = args['sanmar-mode'] ?? process.env.CMP_SANMAR_MODE ?? 'full';
        if (!['full', 'delta'].includes(sanmarMode)) {
          fail('--sanmar-mode must be full or delta.');
        }
        const customerNumber = process.env.CMP_SANMAR_CUSTOMER_NUMBER;
        const username = process.env.CMP_SANMAR_USERNAME;
        const password = process.env.CMP_SANMAR_PASSWORD;
        if (!customerNumber || !username || !password) {
          fail('CMP_SANMAR_CUSTOMER_NUMBER, CMP_SANMAR_USERNAME, and CMP_SANMAR_PASSWORD are required for SanMar SOAP.');
        }

        if (sanmarMode === 'delta') {
          const snapshot = await captureActiveImportSnapshot(target, 'sanmar');
          if (!snapshot) {
            fail('SanMar delta mode requires an active CMP SanMar catalog with source timestamps.');
          }
          sourceConfig = {
            type: 'sanmar-soap-delta',
            customerNumber,
            username,
            password,
            baseImportId: snapshot.importId,
            since: snapshot.watermark,
          };
        } else {
          const bootstrap = await getSanMarSoapBootstrap(target);
          if (bootstrap.styleIds.length === 0 || !bootstrap.since) {
            fail('SanMar SOAP requires an active CMP SanMar catalog with source timestamps; seed local EPDD/DIP or the approved snapshot first.');
          }
          sourceConfig = {
            type: 'sanmar-soap',
            customerNumber,
            username,
            password,
            styleIds: bootstrap.styleIds,
            since: bootstrap.since,
          };
        }
      }
    }

    let result;
    if (sourceConfig.type === 'sanmar-soap-delta') {
      result = await runDeltaIngestion({
        vendor,
        target,
        sourceConfig,
        batchSize,
        signal: controller.signal,
      });
    } else {
      result = await runIngestion({
        vendor,
        target,
        sourceConfig,
        batchSize,
        signal: controller.signal,
      });
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(redactErrorSummary(error.message));
    process.exitCode = 1;
  } finally {
    await target.end();
  }
}

// --- Core orchestration (exported for testing) ---

export async function getSanMarSoapBootstrap(target) {
  const { rows } = await target.query(
    `SELECT source_style_id, source_sync_at
     FROM active_catalog_styles
     WHERE vendor = 'sanmar'
     ORDER BY source_style_id`
  );
  let since = null;
  const styleIds = [];
  for (const row of rows) {
    if (row.source_style_id) styleIds.push(String(row.source_style_id));
    if (row.source_sync_at) {
      const timestamp = new Date(row.source_sync_at);
      if (!Number.isNaN(timestamp.getTime()) && (!since || timestamp < since)) since = timestamp;
    }
  }
  return { styleIds, since: since?.toISOString() ?? null };
}

/**
 * Run a full vendor ingestion cycle with job tracking.
 *
 * @param {Object} options
 * @param {string} options.vendor - "ss" or "sanmar"
 * @param {pg.Pool} options.target - CMP PostgreSQL pool
 * @param {Object} options.sourceConfig - Source configuration
 * @param {number} [options.batchSize=500] - Insert batch size
 * @param {AbortSignal} [options.signal] - Abort signal
 * @param {Function} [options.fetch] - Injectable fetch (testing)
 * @param {Function} [options.sleep] - Injectable sleep (testing)
 * @param {string} [options.leaseOwner] - Lease owner ID
 * @param {number} [options.checkIntervalRows] - Source row cancellation check interval
 * @param {Object} [options.testHooks] - Injectable deterministic hooks for integration tests
 * @returns {Promise<Object>} Ingestion result
 */
export async function runIngestion({
  vendor,
  target,
  sourceConfig,
  batchSize = DEFAULT_BATCH_SIZE,
  signal,
  fetch: fetchFn,
  sleep: sleepFn,
  leaseOwner,
  checkIntervalRows = DEFAULT_CHECK_INTERVAL_ROWS,
  testHooks,
}) {
  const jobId = randomUUID();
  const importId = randomUUID();
  const owner = leaseOwner ?? `worker-${process.pid}-${Date.now()}`;
  let heartbeatTimer = null;

  // Acquire job lease (reclaims stale leases under advisory lock)
  await acquireJobLease(target, jobId, vendor, owner);

  try {
    // Start heartbeat (owner-guarded)
    heartbeatTimer = startHeartbeat(target, jobId, owner);

    // Create import record
    await target.query(
      `INSERT INTO catalog_imports (
         id, vendor, status, source_status, source_errors,
         source_metadata
       ) VALUES ($1, $2, 'building', 'direct', 0, $3::jsonb)`,
      [importId, vendor, JSON.stringify({ source: sourceConfig.type })]
    );

    // Link job to import (owner-guarded, nonterminal)
    await guardedJobUpdate(target,
      `UPDATE catalog_ingestion_jobs
       SET import_id = $2, started_at = CURRENT_TIMESTAMP, status = 'running'
       WHERE id = $1`,
      [jobId, importId],
      jobId, owner
    );

    // Create cancellation check function
    const shouldContinue = async () => {
      if (signal?.aborted) return false;
      return await hasOwnedActiveLease(target, jobId, owner);
    };

    // Run vendor-specific ingestion
    const rawManifest = await ingestVendor({
      vendor,
      sourceConfig,
      importId,
      target,
      batchSize,
      signal,
      fetchFn,
      sleepFn,
      jobId,
      owner,
      shouldContinue,
      checkIntervalRows,
      testHooks,
    });
    const manifest = applySSEmptyStyleActivationException({
      vendor,
      manifest: rawManifest,
      sourceConfig,
    });
    assertManifestCompleteForActivation(manifest);

    // Final cancellation check after staging
    if (!(await shouldContinue())) {
      throw await createLeaseError('Job canceled or lease lost before validation', target, jobId, owner);
    }

    // Validate counts against previous active version
    const previous = await getActiveCounts(target, vendor);
    assertSafeCatalogCounts({
      vendor,
      styleCount: manifest.styleCount,
      variantCount: manifest.variantCount,
      previousStyleCount: previous?.style_count ?? null,
      previousVariantCount: previous?.variant_count ?? null,
    });

    // Update import to validating
    await target.query(
      `UPDATE catalog_imports
       SET status = 'validating', style_count = $2, variant_count = $3,
           invalid_price_count = $4, content_hash = $5,
           source_completed_at = CURRENT_TIMESTAMP,
           source_metadata = source_metadata || $6::jsonb
       WHERE id = $1`,
      [
        importId,
        manifest.styleCount,
        manifest.variantCount,
        manifest.skippedCount,
        manifest.contentHash,
        JSON.stringify(buildManifestSourceMetadata(manifest)),
      ]
    );

    // Update job to validating (owner-guarded)
    await guardedJobUpdate(target,
      `UPDATE catalog_ingestion_jobs SET status = 'validating', checkpoint = $2::jsonb WHERE id = $1`,
      [jobId, JSON.stringify({ phase: 'validating', ...manifest })],
      jobId, owner
    );

    // Validate staged data
    await validateImport(target, importId, vendor, manifest.styleCount, manifest.variantCount);

    if (testHooks?.beforeActivation) await testHooks.beforeActivation({ jobId, owner, importId });

    if (vendor === 'ss') {
      await assertSSPiecePriceInvariant(target, importId);
    }

    // Activate and complete the owned job in one transaction.
    await activateImport(target, importId, vendor, jobId, owner, manifest);

    if (testHooks?.afterActivation) await testHooks.afterActivation({ jobId, owner, importId });

    return {
      vendor,
      jobId,
      importId,
      styleCount: manifest.styleCount,
      variantCount: manifest.variantCount,
      skippedCount: manifest.skippedCount,
      contentHash: manifest.contentHash,
      activated: true,
    };
  } catch (error) {
    const reason = redactErrorSummary(
      error instanceof Error ? error.message : String(error)
    );
    const isCancellation = error.category === ErrorCategory.CANCELED || error.category === 'canceled';

    await rejectAndCleanupInactiveImport(target, importId, reason).catch(() => {});

    // Update job status (owner-guarded, best-effort)
    const finalStatus = isCancellation ? 'canceled' : 'rejected';
    await guardedJobUpdate(target,
      `UPDATE catalog_ingestion_jobs
       SET status = $2, completed_at = CURRENT_TIMESTAMP, error_summary = $3
       WHERE id = $1`,
      [jobId, finalStatus, reason.slice(0, 2000)],
      jobId, owner,
      { allowCancelRequested: isCancellation }
    ).catch(() => {});

    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

async function ingestVendor({
  vendor,
  sourceConfig,
  importId,
  target,
  batchSize,
  signal,
  fetchFn,
  sleepFn,
  jobId,
  owner,
  shouldContinue,
  checkIntervalRows,
  testHooks,
}) {
  const styleBatch = [];
  const variantBatch = [];
  const styleIdMap = new Map(); // sourceStyleId -> generated id
  let styleCount = 0;
  let variantCount = 0;

  async function flushStyles() {
    if (styleBatch.length === 0) return;
    if (shouldContinue && !(await shouldContinue())) {
      throw await createLeaseError('Job canceled or lease lost before style flush', target, jobId, owner);
    }
    const stmt = buildParameterizedInsert({ table: 'catalog_styles', columns: STYLE_COLUMNS, rows: styleBatch });
    await target.query(stmt.text, stmt.values);
    styleBatch.length = 0;
  }

  async function flushVariants() {
    if (variantBatch.length === 0) return;
    if (testHooks?.beforeVariantFlush) await testHooks.beforeVariantFlush({ jobId, owner, importId });
    // A source may emit one style followed immediately by enough variants to
    // fill a variant batch. Persist pending parent styles before their variants
    // so every durable flush satisfies the catalog foreign key.
    await flushStyles();
    const stmt = buildParameterizedInsert({ table: 'catalog_variants', columns: VARIANT_COLUMNS, rows: variantBatch });
    await target.query(stmt.text, stmt.values);
    variantBatch.length = 0;

    // Update checkpoint after each durable flush (owner-guarded)
    await guardedJobUpdate(target,
      `UPDATE catalog_ingestion_jobs SET checkpoint = $2::jsonb WHERE id = $1`,
      [jobId, JSON.stringify({ phase: 'staging', styleCount, variantCount })],
      jobId, owner
    ).catch(() => {}); // Best-effort checkpoint
  }

  function onStyle(style) {
    const id = `${vendor}:${style.sourceStyleId}`;
    styleIdMap.set(style.sourceStyleId, id);
    styleCount++;

    styleBatch.push({
      import_id: importId,
      id,
      vendor,
      source_style_id: style.sourceStyleId,
      style_code: style.styleCode,
      brand: style.brand ?? null,
      name: style.name ?? null,
      category: style.category ?? null,
      description: style.description ?? null,
      image_url: style.imageUrl ?? null,
      active_variant_count: 0, // Will be updated after variants
      source_sync_at: null,
    });

    if (styleBatch.length >= batchSize) return flushStyles();
  }

  async function onVariant(variant) {
    const id = `${vendor}:${variant.sourceVariantId}`;
    const styleId = styleIdMap.get(variant.sourceStyleId) ?? `${vendor}:${variant.sourceStyleId}`;
    variantCount++;

    variantBatch.push({
      import_id: importId,
      id,
      style_id: styleId,
      vendor,
      source_variant_id: variant.sourceVariantId,
      style_code: variant.styleCode,
      color: variant.color ?? null,
      size: variant.size ?? null,
      size_order: variant.sizeOrder ?? null,
      inventory_qty: variant.inventoryQty ?? null,
      image_url: variant.imageUrl ?? null,
      discontinued: variant.discontinued ?? false,
      piece_price: variant.piecePrice ?? null,
      dozen_price: variant.dozenPrice ?? null,
      case_price: variant.casePrice ?? null,
      sale_price: variant.salePrice ?? null,
      customer_price: variant.customerPrice ?? null,
      resolved_cost: variant.resolvedCost,
      cost_basis: variant.costBasis,
      source_sync_at: null,
    });

    if (variantBatch.length >= batchSize) {
      // Check cancellation before each durable flush
      return flushVariants();
    }
  }

  let manifest;

  if (vendor === 'ss') {
    const ssSource = createSSSource({
      accountNumber: sourceConfig.accountNumber,
      apiKey: sourceConfig.apiKey,
      fetch: fetchFn,
      sleep: sleepFn,
      signal,
    });
    manifest = await ssSource.ingest({ onStyle, onVariant, shouldContinue });
  } else if (sourceConfig.type === 'sanmar-soap') {
    const sanmarSource = createSanMarSoapSource({
      customerNumber: sourceConfig.customerNumber,
      username: sourceConfig.username,
      password: sourceConfig.password,
      styleIds: sourceConfig.styleIds,
      since: sourceConfig.since,
      fetch: fetchFn,
      sleep: sleepFn,
      signal,
    });
    manifest = await sanmarSource.ingest({ onStyle, onVariant, shouldContinue });
  } else if (sourceConfig.type === 'sanmar-sdln') {
    manifest = await ingestSanMarSDLN({
      source: sourceConfig.sdlnPath,
      expectedSourceSha256: sourceConfig.expectedSourceSha256,
      onStyle,
      onVariant,
      shouldContinue,
      checkIntervalRows,
    });
  } else {
    manifest = await ingestSanMar({
      epddSource: sourceConfig.epddPath,
      dipSource: sourceConfig.dipPath,
      onStyle,
      onVariant,
      shouldContinue,
      checkIntervalRows,
    });
  }

  // Check cancellation before final flush
  if (shouldContinue && !(await shouldContinue())) {
    throw await createLeaseError('Job canceled or lease lost before final flush', target, jobId, owner);
  }

  // Flush remaining batches
  await flushStyles();
  await flushVariants();

  const sourceSyncAt = manifest.snapshotTimestamp
    ? new Date(manifest.snapshotTimestamp)
    : new Date();
  if (Number.isNaN(sourceSyncAt.getTime())) {
    throw createSourceError(ErrorCategory.VALIDATION, `${vendor} manifest has an invalid snapshot timestamp`);
  }
  await target.query(
    `UPDATE catalog_styles SET source_sync_at = $2 WHERE import_id = $1`,
    [importId, sourceSyncAt]
  );
  await target.query(
    `UPDATE catalog_variants SET source_sync_at = $2 WHERE import_id = $1`,
    [importId, sourceSyncAt]
  );

  if (shouldContinue && !(await shouldContinue())) {
    throw await createLeaseError('Job canceled or lease lost before active variant count update', target, jobId, owner);
  }

  // Update active_variant_count on styles
  await target.query(
    `UPDATE catalog_styles s SET active_variant_count = (
       SELECT count(*)::int FROM catalog_variants v
       WHERE v.import_id = s.import_id AND v.style_id = s.id
     ) WHERE s.import_id = $1`,
    [importId]
  );

  // Update checkpoint (owner-guarded)
  await guardedJobUpdate(target,
    `UPDATE catalog_ingestion_jobs SET checkpoint = $2::jsonb WHERE id = $1`,
    [jobId, JSON.stringify({ phase: 'staged', styleCount, variantCount })],
    jobId, owner
  );

  return manifest;
}

export function assertManifestCompleteForActivation(manifest) {
  if (manifest.complete === false || Number(manifest.sourceErrors ?? 0) > 0) {
    const reasons = Array.isArray(manifest.reasons) && manifest.reasons.length > 0
      ? ` reasons=${JSON.stringify(manifest.reasons).slice(0, 1500)}`
      : '';
    throw new Error(
      `${manifest.vendor} manifest incomplete: ${Number(manifest.sourceErrors ?? 0)} source error(s); refusing activation.${reasons}`
    );
  }
}

export function parseSSEmptyStylePins({
  expectedStyleCount,
  expectedVariantCount,
  expectedEmptyStyleSha256,
} = {}) {
  const values = [expectedStyleCount, expectedVariantCount, expectedEmptyStyleSha256];
  const present = values.map((value) => value != null && String(value).trim() !== '');
  const presentCount = present.filter(Boolean).length;
  if (presentCount === 0) return undefined;
  if (presentCount !== 3) {
    throw new Error(
      'S&S empty-style activation pins must be provided as an all-or-none set: ' +
      '--expected-style-count, --expected-variant-count, and --expected-empty-style-sha256.'
    );
  }

  const styleCount = parsePositiveSafeInteger(expectedStyleCount, 'expected style count');
  const variantCount = parsePositiveSafeInteger(expectedVariantCount, 'expected variant count');
  const emptyStyleSha256 = String(expectedEmptyStyleSha256).trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(emptyStyleSha256)) {
    throw new Error('S&S expected empty-style SHA-256 must be a 64-character hex digest.');
  }

  return { styleCount, variantCount, emptyStyleSha256 };
}

function parsePositiveSafeInteger(value, label) {
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`S&S ${label} must be a positive safe integer.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`S&S ${label} must be a positive safe integer.`);
  }
  return parsed;
}

export function applySSEmptyStyleActivationException({ vendor, manifest, sourceConfig }) {
  const pins = sourceConfig?.expectedEmptyStylePins;
  if (!pins) return manifest;

  const accepted = validateSSEmptyStyleActivationException({ vendor, manifest, pins });
  return {
    ...manifest,
    complete: true,
    sourceErrors: 0,
    ssEmptyStyleActivationException: accepted,
  };
}

export function validateSSEmptyStyleActivationException({ vendor, manifest, pins }) {
  if (vendor !== 'ss' || manifest?.vendor !== 'ss' || sourceConfigType(manifest) !== 'ss-api') {
    throw new Error('S&S empty-style activation exception is only valid for vendor ss and source ss-api.');
  }
  if (manifest.styleCount !== pins.styleCount || manifest.variantCount !== pins.variantCount) {
    throw new Error(
      `S&S empty-style activation exception count mismatch: ` +
      `manifest styles/variants ${manifest.styleCount}/${manifest.variantCount}, ` +
      `expected ${pins.styleCount}/${pins.variantCount}.`
    );
  }
  if (manifest.skippedCount !== 0) {
    throw new Error('S&S empty-style activation exception requires skippedCount=0.');
  }

  const reasons = Array.isArray(manifest.reasons) ? manifest.reasons : [];
  if (reasons.length === 0) {
    throw new Error('S&S empty-style activation exception requires at least one incomplete-style reason.');
  }
  if (Number(manifest.sourceErrors) !== reasons.length) {
    throw new Error(
      'S&S empty-style activation exception requires sourceErrors to equal the represented reason count.'
    );
  }

  const styleIds = [];
  for (const reason of reasons) {
    if (
      reason?.code !== 'ss_style_incomplete' ||
      reason.rawProductCount !== 0 ||
      reason.usableVariantCount !== 0 ||
      typeof reason.styleId !== 'string' ||
      reason.styleId.length === 0
    ) {
      throw new Error(
        'S&S empty-style activation exception only accepts ss_style_incomplete reasons ' +
        'with rawProductCount=0 and usableVariantCount=0.'
      );
    }
    styleIds.push(reason.styleId);
  }

  const sortedUniqueStyleIds = [...new Set(styleIds)].sort();
  if (sortedUniqueStyleIds.length !== reasons.length) {
    throw new Error('S&S empty-style activation exception requires unique incomplete style IDs.');
  }

  const actualSha256 = createHash('sha256')
    .update(`${sortedUniqueStyleIds.join('\n')}\n`)
    .digest('hex');
  if (actualSha256 !== pins.emptyStyleSha256) {
    throw new Error(
      `S&S empty-style activation exception digest mismatch: expected ${pins.emptyStyleSha256}, got ${actualSha256}.`
    );
  }

  return {
    accepted: true,
    expectedStyleCount: pins.styleCount,
    expectedVariantCount: pins.variantCount,
    emptyStyleCount: sortedUniqueStyleIds.length,
    emptyStyleSha256: actualSha256,
    emptyStyleIds: sortedUniqueStyleIds,
  };
}

function sourceConfigType(manifest) {
  return manifest?.source;
}

// --- Delta ingestion orchestration ---

/**
 * Run a delta vendor ingestion cycle: clone active -> discover -> patch -> validate -> activate.
 *
 * @param {Object} options - Same shape as runIngestion plus delta-specific fields
 * @returns {Promise<Object>} Ingestion result
 */
export async function runDeltaIngestion({
  vendor,
  target,
  sourceConfig,
  batchSize = DEFAULT_BATCH_SIZE,
  signal,
  fetch: fetchFn,
  sleep: sleepFn,
  leaseOwner,
  checkIntervalRows = DEFAULT_CHECK_INTERVAL_ROWS,
  testHooks,
}) {
  if (sourceConfig.type !== 'sanmar-soap-delta') {
    throw new Error('runDeltaIngestion only supports sanmar-soap-delta source type');
  }
  if (vendor !== 'sanmar') {
    throw new Error('Delta mode is only supported for sanmar');
  }

  const jobId = randomUUID();
  const importId = randomUUID();
  const owner = leaseOwner ?? `worker-${process.pid}-${Date.now()}`;
  let heartbeatTimer = null;

  await acquireJobLease(target, jobId, vendor, owner);

  try {
    heartbeatTimer = startHeartbeat(target, jobId, owner);

    const shouldContinue = async () => {
      if (signal?.aborted) return false;
      return await hasOwnedActiveLease(target, jobId, owner);
    };

    // Phase 1: Clone active import
    await guardedJobUpdate(target,
      `UPDATE catalog_ingestion_jobs
       SET started_at = CURRENT_TIMESTAMP, status = 'running',
           checkpoint = $2::jsonb
       WHERE id = $1`,
      [jobId, JSON.stringify({ phase: 'cloning' })],
      jobId, owner
    );

    const cloneResult = await cloneActiveImport(target, {
      vendor,
      newImportId: importId,
      baseImportId: sourceConfig.baseImportId,
      jobId,
      leaseOwner: owner,
    });

    await guardedJobUpdate(target,
      `UPDATE catalog_ingestion_jobs
       SET checkpoint = $2::jsonb
       WHERE id = $1`,
      [jobId, JSON.stringify({
        phase: 'cloned',
        baseImportId: cloneResult.baseImportId,
        clonedStyles: cloneResult.clonedStyleCount,
        clonedVariants: cloneResult.clonedVariantCount,
      })],
      jobId, owner
    );

    if (!(await shouldContinue())) {
      throw await createLeaseError('Job canceled or lease lost after cloning', target, jobId, owner);
    }

    // Phase 2: Discover changed/new style IDs and fetch them
    const deltaSource = createSanMarDeltaSource({
      customerNumber: sourceConfig.customerNumber,
      username: sourceConfig.username,
      password: sourceConfig.password,
      since: sourceConfig.since,
      fetch: fetchFn,
      sleep: sleepFn,
      signal,
    });

    const discovery = await deltaSource.discover({ shouldContinue });

    await guardedJobUpdate(target,
      `UPDATE catalog_ingestion_jobs SET checkpoint = $2::jsonb WHERE id = $1`,
      [jobId, JSON.stringify({
        phase: 'discovered',
        modifiedStyleCount: discovery.modifiedStyleIds.length,
        requestCount: discovery.requestCount,
        excludedStyleCount: discovery.excludedStyleCount,
      })],
      jobId, owner
    ).catch(() => {}); // best-effort checkpoint

    if (!(await shouldContinue())) {
      throw await createLeaseError('Job canceled or lease lost after discovery', target, jobId, owner);
    }

    // Phase 3: Patch the clone — delete cloned data for discovered styles, insert fresh data
    let patchedStyleCount = 0;
    let patchedVariantCount = 0;
    const patchedStyleIds = [];
    const removedStyleIds = [];

    if (discovery.results.length > 0) {
      const patchClient = await target.connect();
      try {
        await patchClient.query('BEGIN');
        const patchShouldContinue = async () => {
          if (signal?.aborted) return false;
          return await hasOwnedActiveLease(patchClient, jobId, owner);
        };

        if (!(await patchShouldContinue())) {
          throw await createLeaseError('Job canceled or lease lost before patching', patchClient, jobId, owner);
        }

        // Delete all discovered styles from the clone inside the same transaction
        // that inserts their replacements. Any failure rolls the complete patch back.
        const allDiscoveredIds = discovery.results.map((result) => result.styleId);
        await patchClonedStyles(patchClient, {
          importId,
          vendor,
          styleIds: allDiscoveredIds,
        });

        // Insert fresh data for replace actions.
        for (const result of discovery.results) {
          if (!(await patchShouldContinue())) {
            throw await createLeaseError(
              `Job canceled or lease lost while patching style ${result.styleId}`,
              patchClient,
              jobId,
              owner
            );
          }
          if (testHooks?.beforeDeltaStyleInsert) {
            await testHooks.beforeDeltaStyleInsert({ jobId, owner, importId, styleId: result.styleId });
          }
          if (result.action === 'remove') {
            removedStyleIds.push(result.styleId);
            continue;
          }

          for (const style of result.styles) {
            const id = `${vendor}:${style.sourceStyleId}`;
            const styleBatch = [{
              import_id: importId,
              id,
              vendor,
              source_style_id: style.sourceStyleId,
              style_code: style.styleCode,
              brand: style.brand ?? null,
              name: style.name ?? null,
              category: style.category ?? null,
              description: style.description ?? null,
              image_url: style.imageUrl ?? null,
              active_variant_count: 0,
              source_sync_at: null,
            }];
            const stmt = buildParameterizedInsert({ table: 'catalog_styles', columns: STYLE_COLUMNS, rows: styleBatch });
            await patchClient.query(stmt.text, stmt.values);
            patchedStyleCount++;
            patchedStyleIds.push(style.sourceStyleId);
          }

          for (const variant of result.variants) {
            const id = `${vendor}:${variant.sourceVariantId}`;
            const styleId = `${vendor}:${variant.sourceStyleId}`;
            const variantBatch = [{
              import_id: importId,
              id,
              style_id: styleId,
              vendor,
              source_variant_id: variant.sourceVariantId,
              style_code: variant.styleCode,
              color: variant.color ?? null,
              size: variant.size ?? null,
              size_order: variant.sizeOrder ?? null,
              inventory_qty: variant.inventoryQty ?? null,
              image_url: variant.imageUrl ?? null,
              discontinued: variant.discontinued ?? false,
              piece_price: variant.piecePrice ?? null,
              dozen_price: variant.dozenPrice ?? null,
              case_price: variant.casePrice ?? null,
              sale_price: variant.salePrice ?? null,
              customer_price: variant.customerPrice ?? null,
              resolved_cost: variant.resolvedCost,
              cost_basis: variant.costBasis,
              source_sync_at: null,
            }];
            const stmt = buildParameterizedInsert({ table: 'catalog_variants', columns: VARIANT_COLUMNS, rows: variantBatch });
            await patchClient.query(stmt.text, stmt.values);
            patchedVariantCount++;
          }
        }

        // Set source_sync_at on patched rows. Unchanged cloned rows preserve their
        // prior timestamps, while replaced rows receive the pre-discovery watermark.
        if (patchedStyleIds.length > 0) {
          const sourceSyncAt = discovery.snapshotTimestamp
            ? new Date(discovery.snapshotTimestamp)
            : new Date();
          if (Number.isNaN(sourceSyncAt.getTime())) {
            throw createSourceError(ErrorCategory.VALIDATION, 'Delta manifest has an invalid snapshot timestamp');
          }
          const placeholders = patchedStyleIds.map((_, index) => `$${index + 3}`).join(', ');
          await patchClient.query(
            `UPDATE catalog_styles SET source_sync_at = $2
             WHERE import_id = $1 AND source_style_id IN (${placeholders})`,
            [importId, sourceSyncAt, ...patchedStyleIds]
          );
          await patchClient.query(
            `UPDATE catalog_variants SET source_sync_at = $2
             WHERE import_id = $1 AND style_code IN (${placeholders})`,
            [importId, sourceSyncAt, ...patchedStyleIds]
          );
        }

        if (!(await patchShouldContinue())) {
          throw await createLeaseError('Job canceled or lease lost before patch commit', patchClient, jobId, owner);
        }
        await patchClient.query('COMMIT');
      } catch (error) {
        await patchClient.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        patchClient.release();
      }
    }

    if (!(await shouldContinue())) {
      throw await createLeaseError('Job canceled or lease lost after patching', target, jobId, owner);
    }

    // Phase 4: Recalculate counts and compute content hash
    await recalculateActiveVariantCounts(target, importId);

    // Count the COMPLETE cloned+patched catalog
    const finalCounts = await target.query(
      `SELECT
         (SELECT count(*)::int FROM catalog_styles WHERE import_id = $1) AS style_count,
         (SELECT count(*)::int FROM catalog_variants WHERE import_id = $1) AS variant_count`,
      [importId]
    );
    const styleCount = finalCounts.rows[0].style_count;
    const variantCount = finalCounts.rows[0].variant_count;

    const contentHash = await computeCloneContentHash(target, importId);

    const manifest = {
      vendor,
      styleCount,
      variantCount,
      skippedCount: 0,
      sourceErrors: 0,
      complete: true,
      contentHash,
      source: 'sanmar-soap-delta',
      snapshotTimestamp: discovery.snapshotTimestamp,
      baseImportId: cloneResult.baseImportId,
      clonedStyleCount: cloneResult.clonedStyleCount,
      clonedVariantCount: cloneResult.clonedVariantCount,
      modifiedStyleCount: discovery.modifiedStyleIds.length,
      patchedStyleCount,
      patchedVariantCount,
      removedStyleCount: removedStyleIds.length,
      removedStyleSamples: removedStyleIds.slice(0, 25),
      requestCount: discovery.requestCount,
      excludedStyleCount: discovery.excludedStyleCount,
      reasons: [],
    };

    // Validate counts
    const previous = await getActiveCounts(target, vendor);
    assertSafeCatalogCounts({
      vendor,
      styleCount,
      variantCount,
      previousStyleCount: previous?.style_count ?? null,
      previousVariantCount: previous?.variant_count ?? null,
    });

    // Update import to validating
    await target.query(
      `UPDATE catalog_imports
       SET status = 'validating', style_count = $2, variant_count = $3,
           invalid_price_count = $4, content_hash = $5,
           source_completed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [importId, styleCount, variantCount, manifest.skippedCount, contentHash]
    );

    await guardedJobUpdate(target,
      `UPDATE catalog_ingestion_jobs SET status = 'validating', checkpoint = $2::jsonb WHERE id = $1`,
      [jobId, JSON.stringify({ phase: 'validating', ...manifest })],
      jobId, owner
    );

    // Validate staged data
    await validateImport(target, importId, vendor, styleCount, variantCount);

    if (testHooks?.beforeActivation) await testHooks.beforeActivation({ jobId, owner, importId });

    // Phase 5: Activate with pointer-drift safety
    await activateDeltaImport(target, {
      importId, vendor, baseImportId: sourceConfig.baseImportId,
      jobId, owner, manifest, guardedJobUpdate, leaseErrorFactory: createLeaseError,
    });

    if (testHooks?.afterActivation) await testHooks.afterActivation({ jobId, owner, importId });

    return {
      vendor,
      jobId,
      importId,
      styleCount,
      variantCount,
      skippedCount: manifest.skippedCount,
      contentHash,
      activated: true,
      mode: 'delta',
      baseImportId: cloneResult.baseImportId,
      modifiedStyleCount: discovery.modifiedStyleIds.length,
      patchedStyleCount,
      removedStyleCount: removedStyleIds.length,
    };
  } catch (error) {
    const reason = redactErrorSummary(
      error instanceof Error ? error.message : String(error)
    );
    const isCancellation = error.category === ErrorCategory.CANCELED || error.category === 'canceled';

    await rejectAndCleanupInactiveImport(target, importId, reason).catch(() => {});

    const finalStatus = isCancellation ? 'canceled' : 'rejected';
    await guardedJobUpdate(target,
      `UPDATE catalog_ingestion_jobs
       SET status = $2, completed_at = CURRENT_TIMESTAMP, error_summary = $3
       WHERE id = $1`,
      [jobId, finalStatus, reason.slice(0, 2000)],
      jobId, owner,
      { allowCancelRequested: isCancellation }
    ).catch(() => {});

    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

// --- Job lease management ---

/**
 * Acquire a job lease under per-vendor advisory lock.
 * Reclaims expired queued/running/validating jobs before inserting.
 */
async function acquireJobLease(target, jobId, vendor, owner) {
  const client = await target.connect();
  try {
    await client.query('BEGIN');
    // Per-vendor advisory lock prevents concurrent lease operations
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `cmp-ingestion-lease:${vendor}`,
    ]);

    // Reclaim expired stale jobs (mark rejected with sanitized reason)
    const reclaimed = await client.query(
      `UPDATE catalog_ingestion_jobs
       SET status = 'rejected',
           completed_at = CURRENT_TIMESTAMP,
           error_summary = $1
       WHERE vendor = $2
         AND status IN ('queued', 'running', 'validating')
         AND lease_expires_at < CURRENT_TIMESTAMP
       RETURNING id`,
      [
        redactErrorSummary('Stale lease reclaimed: worker did not renew heartbeat before expiry'),
        vendor,
      ]
    );

    if (reclaimed.rows.length > 0) {
      // Clean up staged data from reclaimed jobs
      for (const row of reclaimed.rows) {
        const reclaimedJobResult = await client.query(
          `SELECT import_id FROM catalog_ingestion_jobs WHERE id = $1`,
          [row.id]
        );
        const reclaimedImportId = reclaimedJobResult.rows[0]?.import_id;
        if (reclaimedImportId) {
          const importState = await client.query(
            `SELECT status
             FROM catalog_imports
             WHERE id = $1
             FOR UPDATE`,
            [reclaimedImportId]
          );
          const activePointer = await client.query(
            `SELECT 1
             FROM active_catalog_versions
             WHERE import_id = $1
             FOR UPDATE`,
            [reclaimedImportId]
          );
          if (importState.rows[0]?.status !== 'active' && activePointer.rowCount === 0) {
            await client.query(`DELETE FROM catalog_variants WHERE import_id = $1`, [reclaimedImportId]);
            await client.query(`DELETE FROM catalog_styles WHERE import_id = $1`, [reclaimedImportId]);
            await client.query(
              `UPDATE catalog_imports SET status = 'rejected', rejection_reason = 'Stale lease reclaimed'
               WHERE id = $1 AND status <> 'active'`,
              [reclaimedImportId]
            );
          }
        }
      }
    }

    // Insert new job
    await client.query(
      `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner, lease_expires_at, heartbeat_at)
       VALUES ($1, $2, 'queued', $3, CURRENT_TIMESTAMP + INTERVAL '${Math.floor(LEASE_DURATION_MS / 1000)} seconds', CURRENT_TIMESTAMP)`,
      [jobId, vendor, owner]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') { // unique_violation
      throw new Error(
        `Cannot start ${vendor} ingestion: another non-terminal job already exists. ` +
        `Wait for it to complete or cancel it first.`
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Owner-guarded job update: only mutates if job ID matches,
 * lease_owner matches, and status is non-terminal.
 * Appends lease_owner and status guards as additional parameters.
 */
async function guardedJobUpdate(target, sql, params, jobId, owner, options = {}) {
  const ownerParamIdx = params.length + 1;
  const cancelGuard = options.allowCancelRequested === true
    ? ''
    : 'AND cancel_requested = FALSE';
  const guardedSql = sql.replace(
    /WHERE id = \$1/,
    `WHERE id = $1
       AND lease_owner = $${ownerParamIdx}
       ${cancelGuard}
       AND status IN ('queued', 'running', 'validating')
       AND lease_expires_at > CURRENT_TIMESTAMP`
  );
  const result = await target.query(guardedSql, [...params, owner]);
  if (result.rowCount !== 1) {
    throw await createLeaseError(`Mandatory job update affected ${result.rowCount} rows`, target, jobId, owner);
  }
  return result;
}

function startHeartbeat(target, jobId, owner) {
  return setInterval(async () => {
    try {
      // Owner-guarded heartbeat
      await target.query(
        `UPDATE catalog_ingestion_jobs
         SET heartbeat_at = CURRENT_TIMESTAMP,
             lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '${Math.floor(LEASE_DURATION_MS / 1000)} seconds'
         WHERE id = $1
           AND lease_owner = $2
           AND cancel_requested = FALSE
           AND status IN ('queued', 'running', 'validating')
           AND lease_expires_at > CURRENT_TIMESTAMP`,
        [jobId, owner]
      );
    } catch {
      // Best-effort heartbeat
    }
  }, HEARTBEAT_INTERVAL_MS);
}

async function hasOwnedActiveLease(target, jobId, owner) {
  const result = await target.query(
    `SELECT 1
     FROM catalog_ingestion_jobs
     WHERE id = $1
       AND lease_owner = $2
       AND cancel_requested = FALSE
       AND status IN ('queued', 'running', 'validating')
       AND lease_expires_at > CURRENT_TIMESTAMP`,
    [jobId, owner]
  );
  return result.rowCount === 1;
}

async function createLeaseError(message, target, jobId, owner) {
  const result = await target.query(
    `SELECT status, cancel_requested, lease_owner, lease_expires_at <= CURRENT_TIMESTAMP AS lease_expired
     FROM catalog_ingestion_jobs
     WHERE id = $1`,
    [jobId]
  ).catch(() => ({ rows: [] }));
  const row = result.rows[0];
  const category = row?.cancel_requested === true ? ErrorCategory.CANCELED : ErrorCategory.LOST_LEASE;
  const detail = row
    ? ` status=${row.status} owner_matches=${row.lease_owner === owner} lease_expired=${row.lease_expired} cancel_requested=${row.cancel_requested}`
    : ' job_missing=true';
  return createSourceError(category, `${message};${detail}`, { retryable: false });
}

async function rejectAndCleanupInactiveImport(target, importId, reason) {
  const client = await target.connect();
  try {
    await client.query('BEGIN');
    const state = await client.query(
      `SELECT status
       FROM catalog_imports
       WHERE id = $1
       FOR UPDATE`,
      [importId]
    );
    const row = state.rows[0];
    const activePointer = row
      ? await client.query(
        `SELECT 1
         FROM active_catalog_versions
         WHERE import_id = $1
         FOR UPDATE`,
        [importId]
      )
      : { rowCount: 0 };
    if (!row || row.status === 'active' || activePointer.rowCount > 0) {
      await client.query('COMMIT');
      return { cleaned: false, activationProtected: Boolean(row) };
    }

    await client.query(`DELETE FROM catalog_variants WHERE import_id = $1`, [importId]);
    await client.query(`DELETE FROM catalog_styles WHERE import_id = $1`, [importId]);
    await client.query(
      `UPDATE catalog_imports
       SET status = 'rejected', rejection_reason = $2
       WHERE id = $1 AND status <> 'active'`,
      [importId, reason.slice(0, 2000)]
    );

    await client.query('COMMIT');
    return { cleaned: true, activationProtected: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// --- Staging/activation (reused from Vendo importer pattern) ---

async function getActiveCounts(target, vendor) {
  const result = await target.query(
    `SELECT i.style_count, i.variant_count
     FROM active_catalog_versions a
     JOIN catalog_imports i ON i.id = a.import_id
     WHERE a.vendor = $1`,
    [vendor]
  );
  return result.rows[0];
}

async function validateImport(target, importId, vendor, styleCount, variantCount) {
  const result = await target.query(
    `SELECT
       (SELECT count(*)::int FROM catalog_styles WHERE import_id = $1) AS styles,
       (SELECT count(*)::int FROM catalog_variants WHERE import_id = $1) AS variants,
       (SELECT count(*)::int FROM catalog_variants v
         LEFT JOIN catalog_styles s
           ON s.import_id = v.import_id AND s.id = v.style_id
         WHERE v.import_id = $1 AND s.id IS NULL) AS orphans,
       (SELECT count(*)::int FROM catalog_variants
         WHERE import_id = $1 AND resolved_cost <= 0) AS invalid_costs,
       (SELECT count(*)::int FROM catalog_styles
         WHERE import_id = $1 AND style_code = $2) AS known_styles`,
    [importId, vendor === 'ss' ? '3001' : 'K500']
  );
  const checks = result.rows[0];
  if (
    Number(checks.styles) !== styleCount ||
    Number(checks.variants) !== variantCount ||
    Number(checks.orphans) !== 0 ||
    Number(checks.invalid_costs) !== 0 ||
    Number(checks.known_styles) < 1
  ) {
    throw new Error(`${vendor} import failed validation: ${JSON.stringify(checks)}`);
  }

  // SanMar case-price invariant: fail-closed before activation
  if (vendor === 'sanmar') {
    await assertSanMarCasePriceInvariant(target, importId);
  }
}

async function activateImport(target, importId, vendor, jobId, owner, manifest) {
  const client = await target.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `cmp-vendor-catalog:${vendor}`,
    ]);
    const job = await client.query(
      `SELECT id
       FROM catalog_ingestion_jobs
       WHERE id = $1
         AND vendor = $2
         AND lease_owner = $3
         AND cancel_requested = FALSE
         AND status IN ('queued', 'running', 'validating')
         AND lease_expires_at > CURRENT_TIMESTAMP
       FOR UPDATE`,
      [jobId, vendor, owner]
    );
    if (job.rowCount !== 1) {
      throw await createLeaseError('Activation refused because job lease is not owned and active', client, jobId, owner);
    }
    const current = await client.query(
      `SELECT import_id FROM active_catalog_versions WHERE vendor = $1 FOR UPDATE`,
      [vendor]
    );
    const previousImportId = current.rows[0]?.import_id;
    if (vendor === 'ss') {
      await assertSSPiecePriceInvariant(client, importId);
    }
    if (vendor === 'sanmar') {
      await assertSanMarCasePriceInvariant(client, importId);
    }
    if (previousImportId) {
      await client.query(
        `UPDATE catalog_imports SET status = 'superseded' WHERE id = $1`,
        [previousImportId]
      );
    }
    const activateResult = await client.query(
      `UPDATE catalog_imports
       SET status = 'active', activated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND vendor = $2 AND status = 'validating'`,
      [importId, vendor]
    );
    if (activateResult.rowCount !== 1) {
      throw new Error(
        `${vendor} activation affected ${activateResult.rowCount} rows (expected 1); aborting.`
      );
    }
    await client.query(
      `INSERT INTO active_catalog_versions (vendor, import_id)
       VALUES ($1, $2)
       ON CONFLICT (vendor) DO UPDATE
       SET import_id = EXCLUDED.import_id, activated_at = CURRENT_TIMESTAMP`,
      [vendor, importId]
    );
    await guardedJobUpdate(client,
      `UPDATE catalog_ingestion_jobs
       SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
           checkpoint = $2::jsonb,
           import_id = $3
       WHERE id = $1`,
      [jobId, JSON.stringify({ phase: 'completed', ...manifest }), importId],
      jobId,
      owner
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// --- Utilities ---

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    result[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

async function computeFileSha256(path) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function buildManifestSourceMetadata(manifest) {
  const metadata = {
    source: manifest.source,
    snapshotTimestamp: manifest.snapshotTimestamp,
  };
  if (manifest.sourceHash) metadata.sourceHash = manifest.sourceHash;
  if (manifest.sourceSha256) metadata.sourceSha256 = manifest.sourceSha256;
  if (manifest.ssEmptyStyleActivationException) {
    metadata.ssEmptyStyleActivationException = manifest.ssEmptyStyleActivationException;
  }
  return metadata;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
