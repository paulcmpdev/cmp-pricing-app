import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { VENDOR_CATALOG_POSTGRES_SCHEMA_SQL } from '../../lib/server/vendor-catalog/postgres-schema.mjs';
import {
  cloneActiveImport,
  patchClonedStyles,
  recalculateActiveVariantCounts,
  computeCloneContentHash,
  captureActiveImportSnapshot,
} from '../lib/delta-clone.mjs';

const TEST_PG_URL = process.env.VENDOR_CATALOG_TEST_DATABASE_URL;
const runIntegration = TEST_PG_URL != null && TEST_PG_URL.length > 0;

const SCHEMA_NAME = `test_delta_clone_${process.pid}_${randomUUID().replaceAll('-', '_')}`;

describe.skipIf(!runIntegration)(
  'delta clone helpers',
  () => {
    let pool: pg.Pool;
    let adminPool: pg.Pool;

    beforeAll(async () => {
      adminPool = new pg.Pool({ connectionString: TEST_PG_URL, max: 1 });
      await adminPool.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
      pool = new pg.Pool({
        connectionString: TEST_PG_URL,
        max: 2,
        options: `-c search_path=${SCHEMA_NAME}`,
      });
      await pool.query(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL);
    });

    afterAll(async () => {
      if (pool) await pool.end();
      if (adminPool) {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
        await adminPool.end();
      }
    });

    async function seedActiveImport(vendor: 'sanmar', styles: Array<{
      sourceStyleId: string;
      styleCode: string;
      brand: string;
      variants: Array<{
        sourceVariantId: string;
        color: string;
        size: string;
        piecePrice: number;
        sourceSyncAt?: string;
      }>;
    }>) {
      const importId = randomUUID();
      let styleCount = 0;
      let variantCount = 0;

      await pool.query(
        `INSERT INTO catalog_imports (
           id, vendor, status, source_status, source_errors,
           style_count, variant_count, invalid_price_count, activated_at, content_hash
         ) VALUES ($1, $2, 'active', 'direct', 0, 0, 0, 0, CURRENT_TIMESTAMP, 'seed-hash')`,
        [importId, vendor]
      );

      for (const style of styles) {
        const id = `${vendor}:${style.sourceStyleId}`;
        styleCount++;
        await pool.query(
          `INSERT INTO catalog_styles (
             import_id, id, vendor, source_style_id, style_code, brand, name,
             category, description, image_url, active_variant_count, source_sync_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, $9, '2026-08-20T00:00:00Z')`,
          [importId, id, vendor, style.sourceStyleId, style.styleCode,
           style.brand, `${style.brand} ${style.styleCode}`, 'Test',
           style.variants.length]
        );
        for (const v of style.variants) {
          variantCount++;
          await pool.query(
            `INSERT INTO catalog_variants (
               import_id, id, style_id, vendor, source_variant_id, style_code,
               color, size, size_order, inventory_qty, image_url, discontinued,
               piece_price, dozen_price, case_price, sale_price, customer_price,
               resolved_cost, cost_basis, source_sync_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, NULL, FALSE,
                       $9, NULL, NULL, NULL, NULL, $9, 'piecePrice',
                       $10)`,
            [importId, `${vendor}:${v.sourceVariantId}`, id, vendor,
             v.sourceVariantId, style.styleCode, v.color, v.size, v.piecePrice,
             v.sourceSyncAt ?? '2026-08-20T00:00:00Z']
          );
        }
      }

      await pool.query(
        `UPDATE catalog_imports SET style_count = $2, variant_count = $3 WHERE id = $1`,
        [importId, styleCount, variantCount]
      );
      await pool.query(
        `INSERT INTO active_catalog_versions (vendor, import_id)
         VALUES ($1, $2)
         ON CONFLICT (vendor) DO UPDATE SET import_id = EXCLUDED.import_id, activated_at = CURRENT_TIMESTAMP`,
        [vendor, importId]
      );

      return importId;
    }

    async function cleanup(vendor: 'sanmar') {
      await pool.query(`DELETE FROM active_catalog_versions WHERE vendor = $1`, [vendor]);
      await pool.query(`DELETE FROM catalog_ingestion_jobs WHERE vendor = $1`, [vendor]);
      await pool.query(`DELETE FROM catalog_imports WHERE vendor = $1`, [vendor]);
    }

    it('clones active import styles and variants into a new import with preserved source_sync_at', async () => {
      await cleanup('sanmar');
      const baseImportId = await seedActiveImport('sanmar', [
        {
          sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
          variants: [
            { sourceVariantId: 'K500-BLK-M', color: 'Black', size: 'M', piecePrice: 11.30 },
            { sourceVariantId: 'K500-BLK-L', color: 'Black', size: 'L', piecePrice: 11.30 },
          ],
        },
        {
          sourceStyleId: 'PC61', styleCode: 'PC61', brand: 'Port & Company',
          variants: [
            { sourceVariantId: 'PC61-NVY-M', color: 'Navy', size: 'M', piecePrice: 4.50 },
          ],
        },
      ]);

      const newImportId = randomUUID();
      const result = await cloneActiveImport(pool, {
        vendor: 'sanmar',
        newImportId,
        baseImportId,
      });

      expect(result.baseImportId).toBe(baseImportId);
      expect(result.clonedStyleCount).toBe(2);
      expect(result.clonedVariantCount).toBe(3);

      // Verify new import record exists
      const importRow = await pool.query(
        `SELECT status, source_status, source_metadata FROM catalog_imports WHERE id = $1`,
        [newImportId]
      );
      expect(importRow.rows[0].status).toBe('building');
      expect(importRow.rows[0].source_status).toBe('direct');

      // Verify cloned styles have new import_id but preserved source_sync_at
      const styles = await pool.query(
        `SELECT id, source_style_id, source_sync_at FROM catalog_styles
         WHERE import_id = $1 ORDER BY source_style_id`,
        [newImportId]
      );
      expect(styles.rows).toHaveLength(2);
      expect(styles.rows[0].source_style_id).toBe('K500');
      expect(styles.rows[0].source_sync_at).not.toBeNull();
      expect(styles.rows[1].source_style_id).toBe('PC61');

      // Verify cloned variants have new import_id but preserved source_sync_at
      const variants = await pool.query(
        `SELECT id, source_variant_id, source_sync_at, resolved_cost
         FROM catalog_variants WHERE import_id = $1 ORDER BY source_variant_id`,
        [newImportId]
      );
      expect(variants.rows).toHaveLength(3);
      expect(variants.rows[0].source_sync_at).not.toBeNull();

      // Active pointer should NOT have changed
      const pointer = await pool.query(
        `SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar'`
      );
      expect(pointer.rows[0].import_id).toBe(baseImportId);
    });

    it('rejects clone when no active import exists', async () => {
      await cleanup('sanmar');
      const newImportId = randomUUID();
      await expect(
        cloneActiveImport(pool, {
          vendor: 'sanmar',
          newImportId,
          baseImportId: randomUUID(),
        })
      ).rejects.toThrow(/no active.*import/i);
    });

    it('rejects clone when base import does not match active pointer', async () => {
      await cleanup('sanmar');
      await seedActiveImport('sanmar', [{
        sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
        variants: [{ sourceVariantId: 'K500-BLK-M', color: 'Black', size: 'M', piecePrice: 11.30 }],
      }]);
      const newImportId = randomUUID();
      await expect(
        cloneActiveImport(pool, {
          vendor: 'sanmar',
          newImportId,
          baseImportId: randomUUID(), // wrong base
        })
      ).rejects.toThrow(/pointer drift|does not match/i);
    });

    it('patches cloned styles by deleting and re-inserting', async () => {
      await cleanup('sanmar');
      const baseImportId = await seedActiveImport('sanmar', [
        {
          sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
          variants: [
            { sourceVariantId: 'K500-BLK-M', color: 'Black', size: 'M', piecePrice: 11.30 },
            { sourceVariantId: 'K500-BLK-L', color: 'Black', size: 'L', piecePrice: 11.30 },
          ],
        },
        {
          sourceStyleId: 'PC61', styleCode: 'PC61', brand: 'Port & Company',
          variants: [
            { sourceVariantId: 'PC61-NVY-M', color: 'Navy', size: 'M', piecePrice: 4.50 },
          ],
        },
      ]);

      const newImportId = randomUUID();
      await cloneActiveImport(pool, { vendor: 'sanmar', newImportId, baseImportId });

      // Patch K500: delete cloned K500, insert updated version
      await patchClonedStyles(pool, {
        importId: newImportId,
        vendor: 'sanmar',
        styleIds: ['K500'],
      });

      // K500 should be deleted from clone
      const styles = await pool.query(
        `SELECT source_style_id FROM catalog_styles WHERE import_id = $1 ORDER BY source_style_id`,
        [newImportId]
      );
      expect(styles.rows).toHaveLength(1);
      expect(styles.rows[0].source_style_id).toBe('PC61');

      // K500 variants should be deleted too
      const variants = await pool.query(
        `SELECT source_variant_id FROM catalog_variants WHERE import_id = $1 ORDER BY source_variant_id`,
        [newImportId]
      );
      expect(variants.rows).toHaveLength(1);
      expect(variants.rows[0].source_variant_id).toBe('PC61-NVY-M');
    });

    it('recalculates active_variant_count for patched styles', async () => {
      await cleanup('sanmar');
      const baseImportId = await seedActiveImport('sanmar', [
        {
          sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
          variants: [
            { sourceVariantId: 'K500-BLK-M', color: 'Black', size: 'M', piecePrice: 11.30 },
          ],
        },
      ]);

      const newImportId = randomUUID();
      await cloneActiveImport(pool, { vendor: 'sanmar', newImportId, baseImportId });

      await recalculateActiveVariantCounts(pool, newImportId);

      const styles = await pool.query(
        `SELECT active_variant_count FROM catalog_styles WHERE import_id = $1`,
        [newImportId]
      );
      expect(styles.rows[0].active_variant_count).toBe(1);
    });

    it('rejects a delta snapshot when any active style has null source_sync_at', async () => {
      await cleanup('sanmar');
      const baseImportId = await seedActiveImport('sanmar', [{
        sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
        variants: [{ sourceVariantId: 'K500-BLK-M', color: 'Black', size: 'M', piecePrice: 11.30 }],
      }]);
      await pool.query(
        `UPDATE catalog_styles SET source_sync_at = NULL WHERE import_id = $1`,
        [baseImportId]
      );

      await expect(captureActiveImportSnapshot(pool, 'sanmar'))
        .rejects.toThrow(/null source_sync_at.*style/i);
    });

    it('rejects a delta snapshot when any active variant has null source_sync_at', async () => {
      await cleanup('sanmar');
      const baseImportId = await seedActiveImport('sanmar', [{
        sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
        variants: [{ sourceVariantId: 'K500-BLK-M', color: 'Black', size: 'M', piecePrice: 11.30 }],
      }]);
      await pool.query(
        `UPDATE catalog_variants SET source_sync_at = NULL WHERE import_id = $1`,
        [baseImportId]
      );

      await expect(captureActiveImportSnapshot(pool, 'sanmar'))
        .rejects.toThrow(/null source_sync_at.*variant/i);
    });

    it('uses the oldest timestamp across both active styles and variants', async () => {
      await cleanup('sanmar');
      const baseImportId = await seedActiveImport('sanmar', [{
        sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
        variants: [{ sourceVariantId: 'K500-BLK-M', color: 'Black', size: 'M', piecePrice: 11.30 }],
      }]);
      await pool.query(
        `UPDATE catalog_styles SET source_sync_at = '2026-08-22T12:00:00Z' WHERE import_id = $1`,
        [baseImportId]
      );
      await pool.query(
        `UPDATE catalog_variants SET source_sync_at = '2026-08-21T10:00:00Z' WHERE import_id = $1`,
        [baseImportId]
      );

      const snapshot = await captureActiveImportSnapshot(pool, 'sanmar');
      expect(snapshot?.watermark).toBe('2026-08-21T10:00:00.000Z');
    });

    it('computes content hash over all styles+variants in deterministic order', async () => {
      await cleanup('sanmar');
      const baseImportId = await seedActiveImport('sanmar', [
        {
          sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
          variants: [
            { sourceVariantId: 'K500-BLK-M', color: 'Black', size: 'M', piecePrice: 11.30 },
          ],
        },
      ]);

      const newImportId = randomUUID();
      await cloneActiveImport(pool, { vendor: 'sanmar', newImportId, baseImportId });

      const hash = await computeCloneContentHash(pool, newImportId);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);

      // Same data should produce same hash
      const hash2 = await computeCloneContentHash(pool, newImportId);
      expect(hash2).toBe(hash);
    });

    it('changes the canonical hash for image, inventory, price, and timestamp-only changes', async () => {
      await cleanup('sanmar');
      const importId = await seedActiveImport('sanmar', [{
        sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
        variants: [{ sourceVariantId: 'K500-BLK-M', color: 'Black', size: 'M', piecePrice: 11.30 }],
      }]);

      const baseline = await computeCloneContentHash(pool, importId);
      await pool.query(
        `UPDATE catalog_styles SET image_url = 'https://example.test/k500.jpg' WHERE import_id = $1`,
        [importId]
      );
      const imageChanged = await computeCloneContentHash(pool, importId);
      expect(imageChanged).not.toBe(baseline);

      await pool.query(
        `UPDATE catalog_variants SET inventory_qty = 42 WHERE import_id = $1`,
        [importId]
      );
      const inventoryChanged = await computeCloneContentHash(pool, importId);
      expect(inventoryChanged).not.toBe(imageChanged);

      await pool.query(
        `UPDATE catalog_variants SET piece_price = 12.30, resolved_cost = 12.30 WHERE import_id = $1`,
        [importId]
      );
      const priceChanged = await computeCloneContentHash(pool, importId);
      expect(priceChanged).not.toBe(inventoryChanged);

      await pool.query(
        `UPDATE catalog_variants SET source_sync_at = source_sync_at + INTERVAL '1 second' WHERE import_id = $1`,
        [importId]
      );
      const timestampChanged = await computeCloneContentHash(pool, importId);
      expect(timestampChanged).not.toBe(priceChanged);
    });
  }
);
