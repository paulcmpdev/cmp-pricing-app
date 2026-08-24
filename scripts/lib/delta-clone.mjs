/**
 * Delta clone helpers for immutable catalog versioning.
 *
 * Clones an active SanMar import's styles and variants into a new import_id
 * using SQL INSERT...SELECT (no JS materialization of 150k+ rows).
 * Supports patch (delete + re-insert) for changed/new/removed styles,
 * and pointer-drift-safe activation.
 */

import { createHash } from 'node:crypto';
import { assertSanMarCasePriceInvariant } from './postgres-import-helpers.mjs';

/**
 * Clone the active import for a vendor into a new import record.
 * Uses INSERT...SELECT to avoid materializing rows in JS.
 *
 * @param {import('pg').Pool} target - PostgreSQL pool
 * @param {Object} options
 * @param {string} options.vendor - Vendor key ('sanmar')
 * @param {string} options.newImportId - UUID for the new import
 * @param {string} options.baseImportId - Expected active import ID (pointer drift guard)
 * @param {Object} [options.sourceMetadata] - Additional metadata for the import record
 * @returns {Promise<{baseImportId: string, clonedStyleCount: number, clonedVariantCount: number}>}
 */
export async function cloneActiveImport(target, {
  vendor,
  newImportId,
  baseImportId,
  sourceMetadata = {},
  jobId,
  leaseOwner,
}) {
  const client = await target.connect();
  try {
    await client.query('BEGIN');

    // Lock the active pointer to prevent concurrent activation
    const active = await client.query(
      `SELECT a.import_id
       FROM active_catalog_versions a
       JOIN catalog_imports i ON i.id = a.import_id AND i.status = 'active'
       WHERE a.vendor = $1
       FOR UPDATE`,
      [vendor]
    );

    if (active.rows.length === 0) {
      throw new Error(`Delta clone failed: no active ${vendor} import exists. Delta mode requires an active baseline.`);
    }

    const activeImportId = active.rows[0].import_id;
    if (activeImportId !== baseImportId) {
      throw new Error(
        `Delta clone pointer drift: active import ${activeImportId} does not match expected base ${baseImportId}. ` +
        `Another activation may have occurred concurrently.`
      );
    }

    // Create the new import record
    await client.query(
      `INSERT INTO catalog_imports (
         id, vendor, status, source_status, source_errors,
         source_metadata
       ) VALUES ($1, $2, 'building', 'direct', 0, $3::jsonb)`,
      [newImportId, vendor, JSON.stringify({ source: 'sanmar-soap-delta', baseImportId, ...sourceMetadata })]
    );

    // Clone styles: new import_id, preserve all other columns including source_sync_at
    const styleResult = await client.query(
      `INSERT INTO catalog_styles (
         import_id, id, vendor, source_style_id, style_code, brand, name,
         category, description, image_url, active_variant_count, source_sync_at
       )
       SELECT $1, id, vendor, source_style_id, style_code, brand, name,
              category, description, image_url, active_variant_count, source_sync_at
       FROM catalog_styles
       WHERE import_id = $2`,
      [newImportId, baseImportId]
    );

    // Clone variants: new import_id, preserve all other columns including source_sync_at
    const variantResult = await client.query(
      `INSERT INTO catalog_variants (
         import_id, id, style_id, vendor, source_variant_id, style_code,
         color, size, size_order, inventory_qty, image_url, discontinued,
         piece_price, dozen_price, case_price, sale_price, customer_price,
         resolved_cost, cost_basis, source_sync_at
       )
       SELECT $1, id, style_id, vendor, source_variant_id, style_code,
              color, size, size_order, inventory_qty, image_url, discontinued,
              piece_price, dozen_price, case_price, sale_price, customer_price,
              resolved_cost, cost_basis, source_sync_at
       FROM catalog_variants
       WHERE import_id = $2`,
      [newImportId, baseImportId]
    );

    // Make the staged import and its recovery handle durable together. Without
    // this link in the clone transaction, a crash after COMMIT but before the
    // caller updates the job can leave an orphaned staged import.
    if (jobId || leaseOwner) {
      if (!jobId || !leaseOwner) {
        throw new Error('Delta clone jobId and leaseOwner must be provided together');
      }
      const linked = await client.query(
        `UPDATE catalog_ingestion_jobs
         SET import_id = $2
         WHERE id = $1
           AND vendor = $3
           AND lease_owner = $4
           AND cancel_requested = FALSE
           AND status IN ('queued', 'running', 'validating')
           AND lease_expires_at > CURRENT_TIMESTAMP`,
        [jobId, newImportId, vendor, leaseOwner]
      );
      if (linked.rowCount !== 1) {
        throw new Error('Delta clone refused: ingestion job lease is not owned and active');
      }
    }

    await client.query('COMMIT');

    return {
      baseImportId,
      clonedStyleCount: styleResult.rowCount,
      clonedVariantCount: variantResult.rowCount,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Delete cloned styles and their variants for a set of style IDs.
 * Called before re-inserting fresh data from SOAP, or to leave deleted
 * when a style is confirmed unavailable.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} target
 * @param {Object} options
 * @param {string} options.importId - The new (cloned) import ID
 * @param {string} options.vendor - Vendor key
 * @param {string[]} options.styleIds - Source style IDs to remove from clone
 * @returns {Promise<{deletedStyles: number, deletedVariants: number}>}
 */
export async function patchClonedStyles(target, { importId, vendor, styleIds }) {
  if (styleIds.length === 0) return { deletedStyles: 0, deletedVariants: 0 };

  // Build parameterized IN clause
  const placeholders = styleIds.map((_, i) => `$${i + 3}`).join(', ');
  const params = [importId, vendor, ...styleIds];

  // Delete variants first (FK), then styles
  const variantResult = await target.query(
    `DELETE FROM catalog_variants
     WHERE import_id = $1 AND vendor = $2
       AND style_code IN (${placeholders})`,
    params
  );

  const styleResult = await target.query(
    `DELETE FROM catalog_styles
     WHERE import_id = $1 AND vendor = $2
       AND source_style_id IN (${placeholders})`,
    params
  );

  return {
    deletedStyles: styleResult.rowCount,
    deletedVariants: variantResult.rowCount,
  };
}

/**
 * Recalculate active_variant_count for all styles in an import.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} target
 * @param {string} importId
 */
export async function recalculateActiveVariantCounts(target, importId) {
  await target.query(
    `UPDATE catalog_styles s SET active_variant_count = (
       SELECT count(*)::int FROM catalog_variants v
       WHERE v.import_id = s.import_id AND v.style_id = s.id
     ) WHERE s.import_id = $1`,
    [importId]
  );
}

/**
 * Compute a deterministic content hash over all styles and variants in an import.
 * Orders by source_style_id/source_variant_id to ensure determinism.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} target
 * @param {string} importId
 * @returns {Promise<string>} SHA-256 hex digest
 */
export async function computeCloneContentHash(target, importId) {
  const hash = createHash('sha256');

  // Hash every persisted style field that affects catalog truth. Prefix record
  // kinds so style/variant JSON cannot collide across the stream boundary.
  const styles = await target.query(
    `SELECT id, vendor, source_style_id, style_code, brand, name, category,
            description, image_url, active_variant_count, source_sync_at
     FROM catalog_styles
     WHERE import_id = $1
     ORDER BY id`,
    [importId]
  );
  hash.update('catalog-styles-v1\n');
  for (const row of styles.rows) {
    hash.update(`style\u0000${JSON.stringify(row)}\n`);
  }

  const variants = await target.query(
    `SELECT id, style_id, vendor, source_variant_id, style_code, color, size,
            size_order, inventory_qty, image_url, discontinued, piece_price,
            dozen_price, case_price, sale_price, customer_price, resolved_cost,
            cost_basis, source_sync_at
     FROM catalog_variants
     WHERE import_id = $1
     ORDER BY id`,
    [importId]
  );
  hash.update('catalog-variants-v1\n');
  for (const row of variants.rows) {
    hash.update(`variant\u0000${JSON.stringify(row)}\n`);
  }

  return hash.digest('hex');
}

/**
 * Capture the current active import ID for a vendor under a transactional lock.
 * Returns the import_id and the oldest source_sync_at watermark.
 *
 * @param {import('pg').Pool} target
 * @param {string} vendor
 * @returns {Promise<{importId: string, watermark: string} | null>}
 */
export async function captureActiveImportSnapshot(target, vendor) {
  const client = await target.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `cmp-delta-snapshot:${vendor}`,
    ]);

    const active = await client.query(
      `SELECT a.import_id
       FROM active_catalog_versions a
       JOIN catalog_imports i ON i.id = a.import_id AND i.status = 'active'
       WHERE a.vendor = $1
       FOR UPDATE`,
      [vendor]
    );

    if (active.rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }

    const importId = active.rows[0].import_id;

    // Delta coverage is only sound when every active row carries a source
    // watermark. MIN() ignores NULL, so count them explicitly and fail closed.
    const watermarkResult = await client.query(
      `SELECT
         (SELECT count(*)::int
          FROM catalog_styles
          WHERE import_id = $1 AND source_sync_at IS NULL) AS null_style_timestamps,
         (SELECT count(*)::int
          FROM catalog_variants
          WHERE import_id = $1 AND source_sync_at IS NULL) AS null_variant_timestamps,
         (SELECT MIN(source_sync_at)
          FROM catalog_styles
          WHERE import_id = $1) AS oldest_style_sync,
         (SELECT MIN(source_sync_at)
          FROM catalog_variants
          WHERE import_id = $1) AS oldest_variant_sync`,
      [importId]
    );

    const coverage = watermarkResult.rows[0];
    if (Number(coverage?.null_style_timestamps ?? 0) > 0) {
      throw new Error(
        `SanMar delta refused: null source_sync_at found in active style rows for import ${importId}`
      );
    }
    if (Number(coverage?.null_variant_timestamps ?? 0) > 0) {
      throw new Error(
        `SanMar delta refused: null source_sync_at found in active variant rows for import ${importId}`
      );
    }

    const watermarkCandidates = [coverage?.oldest_style_sync, coverage?.oldest_variant_sync]
      .filter(Boolean)
      .map((value) => new Date(value));
    if (watermarkCandidates.length === 0 || watermarkCandidates.some((value) => Number.isNaN(value.getTime()))) {
      throw new Error(`SanMar delta refused: active import ${importId} has no source watermark`);
    }
    const watermark = new Date(Math.min(...watermarkCandidates.map((value) => value.getTime())));

    await client.query('COMMIT');

    return {
      importId,
      watermark: watermark.toISOString(),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Activate a cloned delta import with pointer-drift safety.
 * Verifies the active pointer still matches the base import before activation.
 *
 * @param {import('pg').Pool} target
 * @param {Object} options
 * @param {string} options.importId - New import to activate
 * @param {string} options.vendor - Vendor key
 * @param {string} options.baseImportId - Expected active import (drift guard)
 * @param {string} options.jobId - Ingestion job ID
 * @param {string} options.owner - Lease owner
 * @param {Object} options.manifest - Completeness manifest
 * @param {Function} options.guardedJobUpdate - Owner-guarded job update function
 */
export async function activateDeltaImport(target, {
  importId, vendor, baseImportId, jobId, owner, manifest, guardedJobUpdate,
  leaseErrorFactory,
}) {
  const client = await target.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `cmp-vendor-catalog:${vendor}`,
    ]);

    // Verify lease is still owned
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
      if (leaseErrorFactory) {
        throw await leaseErrorFactory(
          'Delta activation refused because job lease is not owned and active',
          client,
          jobId,
          owner
        );
      }
      throw new Error('Delta activation refused: job lease is not owned and active');
    }

    // Pointer drift check: active must still be our base
    const current = await client.query(
      `SELECT import_id FROM active_catalog_versions WHERE vendor = $1 FOR UPDATE`,
      [vendor]
    );
    const currentActiveId = current.rows[0]?.import_id;
    if (currentActiveId !== baseImportId) {
      throw new Error(
        `Delta activation pointer drift: active import changed from ${baseImportId} to ${currentActiveId} during processing`
      );
    }

    if (vendor === 'sanmar') {
      await assertSanMarCasePriceInvariant(client, importId);
    }

    // Supersede the base import
    await client.query(
      `UPDATE catalog_imports SET status = 'superseded' WHERE id = $1`,
      [baseImportId]
    );

    // Activate the new import
    const activateResult = await client.query(
      `UPDATE catalog_imports
       SET status = 'active', activated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND vendor = $2 AND status = 'validating'`,
      [importId, vendor]
    );
    if (activateResult.rowCount !== 1) {
      throw new Error(
        `Delta activation affected ${activateResult.rowCount} rows (expected 1); aborting.`
      );
    }

    // Update the active pointer
    await client.query(
      `INSERT INTO active_catalog_versions (vendor, import_id)
       VALUES ($1, $2)
       ON CONFLICT (vendor) DO UPDATE
       SET import_id = EXCLUDED.import_id, activated_at = CURRENT_TIMESTAMP`,
      [vendor, importId]
    );

    // Complete the job
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
