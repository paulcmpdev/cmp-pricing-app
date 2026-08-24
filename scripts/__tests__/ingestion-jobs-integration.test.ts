import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VENDOR_CATALOG_POSTGRES_SCHEMA_SQL } from '../../lib/server/vendor-catalog/postgres-schema.mjs';
import { createPostgresVendorCatalogRepository } from '../../lib/server/vendor-catalog/postgres-repository';
import { runIngestion } from '../sync-vendor-catalog.mjs';
import {
  SS_PRODUCTS_BATCH_1,
  SS_PRODUCTS_BATCH_2,
  SS_PRODUCT_NO_PRICE,
  SS_STYLES_RESPONSE,
} from '../../tests/fixtures/vendor-sources/ss-fixtures.mjs';
import {
  DIP_HEADERS,
  DIP_VALID_CONTENT,
  EPDD_HEADERS,
  EPDD_VALID_CONTENT,
} from '../../tests/fixtures/vendor-sources/sanmar-fixtures.mjs';
import {
  SANMAR_SOAP_FAULT_RESPONSE,
  SANMAR_SOAP_PRODUCT_RESPONSE,
} from '../../tests/fixtures/vendor-sources/sanmar-soap-fixtures.mjs';

const TEST_PG_URL = process.env.VENDOR_CATALOG_TEST_DATABASE_URL;
const runIntegration = TEST_PG_URL != null && TEST_PG_URL.length > 0;

const SCHEMA_NAME = `test_ingestion_jobs_${process.pid}_${randomUUID().replaceAll('-', '_')}`;

type IngestionResult = {
  activated: boolean;
  importId: string;
  jobId: string;
  styleCount: number;
  variantCount: number;
  skippedCount: number;
};

describe.skipIf(!runIntegration)(
  'catalog_ingestion_jobs integration',
  () => {
    let pool: pg.Pool;
    let adminPool: pg.Pool;
    const tempDirs: string[] = [];

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
      await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
      if (pool) {
        await pool.end();
      }
      if (adminPool) {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
        await adminPool.end();
      }
    });

    async function resetVendor(vendor: 'ss' | 'sanmar') {
      await pool.query(`DELETE FROM active_catalog_versions WHERE vendor = $1`, [vendor]);
      await pool.query(`DELETE FROM catalog_ingestion_jobs WHERE vendor = $1`, [vendor]);
      await pool.query(`DELETE FROM catalog_imports WHERE vendor = $1`, [vendor]);
    }

    async function seedActiveBaseline(
      vendor: 'ss' | 'sanmar',
      counts: { styles: number; variants: number } = { styles: 3, variants: 5 }
    ) {
      const importId = randomUUID();
      const styleId = vendor === 'ss' ? 'ss:baseline-3001' : 'sanmar:baseline-K500';
      const variantId = vendor === 'ss' ? 'ss:baseline-3001-BLK-M' : 'sanmar:baseline-K500-BLK-M';
      const styleCode = vendor === 'ss' ? '3001' : 'K500';

      await pool.query(
        `INSERT INTO catalog_imports (
           id, vendor, status, source_status, source_errors,
           style_count, variant_count, invalid_price_count, activated_at
         ) VALUES ($1, $2, 'active', 'direct', 0, $3, $4, 0, CURRENT_TIMESTAMP)`,
        [importId, vendor, counts.styles, counts.variants]
      );
      await pool.query(
        `INSERT INTO active_catalog_versions (vendor, import_id) VALUES ($1, $2)`,
        [vendor, importId]
      );
      await pool.query(
        `INSERT INTO catalog_styles (
           import_id, id, vendor, source_style_id, style_code, brand, name,
           category, description, image_url, active_variant_count, source_sync_at
         ) VALUES ($1, $2, $3, $4, $5, 'Baseline', 'Prior active', 'Baseline',
                   NULL, NULL, 1, NULL)`,
        [importId, styleId, vendor, styleCode, styleCode]
      );
      await pool.query(
        `INSERT INTO catalog_variants (
           import_id, id, style_id, vendor, source_variant_id, style_code,
           color, size, size_order, inventory_qty, image_url, discontinued,
           piece_price, dozen_price, case_price, sale_price, customer_price,
           resolved_cost, cost_basis, source_sync_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'Black', 'M', NULL, 1, NULL, FALSE,
                   1.00, NULL, NULL, NULL, NULL, 1.00, 'piecePrice', NULL)`,
        [importId, variantId, styleId, vendor, variantId, styleCode]
      );
      return importId;
    }

    function ssFetchFixture({
      styles = SS_STYLES_RESPONSE,
      products = [...SS_PRODUCTS_BATCH_1, ...SS_PRODUCTS_BATCH_2],
      throwMessage,
    }: {
      styles?: any[];
      products?: any[];
      throwMessage?: string;
    } = {}) {
      return async (url: string) => {
        if (throwMessage) throw new Error(throwMessage);
        const parsed = new URL(url);
        const headers = { 'content-type': 'application/json', 'x-rate-limit-remaining': '99' };
        if (parsed.pathname === '/v2/styles/') {
          return new Response(JSON.stringify(styles), { status: 200, headers });
        }
        if (parsed.pathname === '/v2/products/') {
          const requested = new Set((parsed.searchParams.get('styleid') ?? '').split(','));
          const rows = products.filter((product) => requested.has(String(product.styleID)));
          return new Response(JSON.stringify(rows), { status: 200, headers });
        }
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers });
      };
    }

    function sanmarSoapFetchFixture(body = SANMAR_SOAP_PRODUCT_RESPONSE) {
      return async (url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/SanMarWebService/SanMarProductInfoServicePort') {
          return new Response(body, { status: 200, headers: { 'content-type': 'text/xml' } });
        }
        return new Response(SANMAR_SOAP_FAULT_RESPONSE, {
          status: 500,
          headers: { 'content-type': 'text/xml' },
        });
      };
    }

    function repo() {
      return createPostgresVendorCatalogRepository({
        async query(text: string, values?: unknown[]) {
          const result = await pool.query(text, values);
          return { rows: result.rows };
        },
      });
    }

    function ssEmptyStyleDigest(styleIds: string[]) {
      return createHash('sha256').update(`${[...styleIds].sort().join('\n')}\n`).digest('hex');
    }

    async function writeSanMarFiles(epdd: string, dip: string) {
      const tempDir = await mkdtemp(join(tmpdir(), 'sanmar-ingestion-'));
      tempDirs.push(tempDir);
      const epddPath = join(tempDir, 'epdd.csv');
      const dipPath = join(tempDir, 'dip.txt');
      await writeFile(epddPath, epdd, 'utf8');
      await writeFile(dipPath, dip, 'utf8');
      return { epddPath, dipPath };
    }

    it('creates ingestion_jobs table with all columns', async () => {
      const result = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = '${SCHEMA_NAME}' AND table_name = 'catalog_ingestion_jobs'
         ORDER BY ordinal_position`
      );
      const columns = result.rows.map((r: { column_name: string }) => r.column_name);
      expect(columns).toContain('id');
      expect(columns).toContain('vendor');
      expect(columns).toContain('status');
      expect(columns).toContain('lease_owner');
      expect(columns).toContain('lease_expires_at');
      expect(columns).toContain('heartbeat_at');
      expect(columns).toContain('cancel_requested');
      expect(columns).toContain('checkpoint');
      expect(columns).toContain('attempts');
      expect(columns).toContain('error_summary');
      expect(columns).toContain('import_id');
      expect(columns).toContain('created_at');
      expect(columns).toContain('started_at');
      expect(columns).toContain('completed_at');
    });

    it('enforces one non-terminal job per vendor', async () => {
      const jobId1 = '10000000-0000-0000-0000-000000000001';
      const jobId2 = '10000000-0000-0000-0000-000000000002';

      await pool.query(
        `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner)
         VALUES ($1, 'ss', 'running', 'worker-1')`,
        [jobId1]
      );

      // Second non-terminal job for same vendor should fail
      await expect(
        pool.query(
          `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner)
           VALUES ($1, 'ss', 'queued', 'worker-2')`,
          [jobId2]
        )
      ).rejects.toThrow();

      // But a different vendor should succeed
      const jobId3 = '10000000-0000-0000-0000-000000000003';
      await pool.query(
        `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner)
         VALUES ($1, 'sanmar', 'queued', 'worker-2')`,
        [jobId3]
      );

      // Completing the first job should allow a new one
      await pool.query(
        `UPDATE catalog_ingestion_jobs SET status = 'completed' WHERE id = $1`,
        [jobId1]
      );

      await pool.query(
        `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner)
         VALUES ($1, 'ss', 'queued', 'worker-3')`,
        [jobId2]
      );

      // Cleanup
      await pool.query(
        `DELETE FROM catalog_ingestion_jobs WHERE id IN ($1, $2, $3)`,
        [jobId1, jobId2, jobId3]
      );
    });

    it('allows terminal status jobs even with existing terminal jobs', async () => {
      const jobId1 = '20000000-0000-0000-0000-000000000001';
      const jobId2 = '20000000-0000-0000-0000-000000000002';

      await pool.query(
        `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner)
         VALUES ($1, 'ss', 'completed', 'worker-1')`,
        [jobId1]
      );

      await pool.query(
        `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner)
         VALUES ($1, 'ss', 'rejected', 'worker-2')`,
        [jobId2]
      );

      const jobId3 = '20000000-0000-0000-0000-000000000003';
      await pool.query(
        `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner)
         VALUES ($1, 'ss', 'queued', 'worker-3')`,
        [jobId3]
      );

      // Cleanup
      await pool.query(
        `DELETE FROM catalog_ingestion_jobs WHERE id IN ($1, $2, $3)`,
        [jobId1, jobId2, jobId3]
      );
    });

    it('links job to import via FK', async () => {
      const importId = '30000000-0000-0000-0000-000000000001';
      const jobId = '30000000-0000-0000-0000-000000000002';

      await pool.query(
        `INSERT INTO catalog_imports (id, vendor, status, source_status, source_errors)
         VALUES ($1, 'ss', 'building', 'direct', 0)`,
        [importId]
      );

      await pool.query(
        `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner, import_id)
         VALUES ($1, 'ss', 'running', 'worker-1', $2)`,
        [jobId, importId]
      );

      // FK should prevent linking to non-existent import
      const badJobId = '30000000-0000-0000-0000-000000000003';
      await expect(
        pool.query(
          `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner, import_id)
           VALUES ($1, 'ss', 'completed', 'worker-2', '99999999-9999-9999-9999-999999999999')`,
          [badJobId]
        )
      ).rejects.toThrow();

      // Cleanup
      await pool.query(`DELETE FROM catalog_ingestion_jobs WHERE id = $1`, [jobId]);
      await pool.query(`DELETE FROM catalog_imports WHERE id = $1`, [importId]);
    });

    it('supports cancel_requested flag', async () => {
      const jobId = '40000000-0000-0000-0000-000000000001';

      await pool.query(
        `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner)
         VALUES ($1, 'ss', 'running', 'worker-1')`,
        [jobId]
      );

      const before = await pool.query(
        `SELECT cancel_requested FROM catalog_ingestion_jobs WHERE id = $1`,
        [jobId]
      );
      expect((before.rows[0] as { cancel_requested: boolean }).cancel_requested).toBe(false);

      await pool.query(
        `UPDATE catalog_ingestion_jobs SET cancel_requested = TRUE WHERE id = $1`,
        [jobId]
      );

      const after = await pool.query(
        `SELECT cancel_requested FROM catalog_ingestion_jobs WHERE id = $1`,
        [jobId]
      );
      expect((after.rows[0] as { cancel_requested: boolean }).cancel_requested).toBe(true);

      // Cleanup
      await pool.query(
        `UPDATE catalog_ingestion_jobs SET status = 'canceled' WHERE id = $1`,
        [jobId]
      );
      await pool.query(`DELETE FROM catalog_ingestion_jobs WHERE id = $1`, [jobId]);
    });

    it('stores checkpoint JSON', async () => {
      const jobId = '50000000-0000-0000-0000-000000000001';
      const checkpoint = { phase: 'staging', stylesProcessed: 100, variantsProcessed: 5000 };

      await pool.query(
        `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner, checkpoint)
         VALUES ($1, 'ss', 'running', 'worker-1', $2::jsonb)`,
        [jobId, JSON.stringify(checkpoint)]
      );

      const result = await pool.query(
        `SELECT checkpoint FROM catalog_ingestion_jobs WHERE id = $1`,
        [jobId]
      );
      expect((result.rows[0] as { checkpoint: typeof checkpoint }).checkpoint).toEqual(checkpoint);

      // Cleanup
      await pool.query(
        `UPDATE catalog_ingestion_jobs SET status = 'completed' WHERE id = $1`,
        [jobId]
      );
      await pool.query(`DELETE FROM catalog_ingestion_jobs WHERE id = $1`, [jobId]);
    });

    it('schema is idempotent (can be re-applied)', async () => {
      await pool.query(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL);

      const result = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = '${SCHEMA_NAME}' AND table_name = 'catalog_ingestion_jobs'`
      );
      expect(result.rows).toHaveLength(1);
    });

    // --- Behavioral tests: stale lease reclamation ---

    it('live lease blocks new job for same vendor', async () => {
      const jobId = '60000000-0000-0000-0000-000000000001';
      await pool.query(
        `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner, lease_expires_at, heartbeat_at)
         VALUES ($1, 'ss', 'running', 'active-worker',
                 CURRENT_TIMESTAMP + INTERVAL '600 seconds', CURRENT_TIMESTAMP)`,
        [jobId]
      );

      // Another non-terminal job for same vendor should fail
      const jobId2 = '60000000-0000-0000-0000-000000000002';
      await expect(
        pool.query(
          `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner)
           VALUES ($1, 'ss', 'queued', 'new-worker')`,
          [jobId2]
        )
      ).rejects.toThrow();

      // Cleanup
      await pool.query(`UPDATE catalog_ingestion_jobs SET status = 'completed' WHERE id = $1`, [jobId]);
      await pool.query(`DELETE FROM catalog_ingestion_jobs WHERE id = $1`, [jobId]);
    });

    it('wrong owner cannot mutate non-terminal job', async () => {
      const jobId = '70000000-0000-0000-0000-000000000001';
      await pool.query(
        `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner,
                 lease_expires_at, heartbeat_at, checkpoint)
         VALUES ($1, 'ss', 'running', 'real-owner',
                 CURRENT_TIMESTAMP + INTERVAL '600 seconds', CURRENT_TIMESTAMP, '{"phase":"test"}'::jsonb)`,
        [jobId]
      );

      // Wrong owner update should affect 0 rows
      const result = await pool.query(
        `UPDATE catalog_ingestion_jobs
         SET checkpoint = '{"phase":"hijacked"}'::jsonb
         WHERE id = $1 AND lease_owner = 'wrong-owner' AND status IN ('queued', 'running', 'validating')`,
        [jobId]
      );
      expect(result.rowCount).toBe(0);

      // Checkpoint should be unchanged
      const check = await pool.query(
        `SELECT checkpoint FROM catalog_ingestion_jobs WHERE id = $1`,
        [jobId]
      );
      expect((check.rows[0] as any).checkpoint.phase).toBe('test');

      // Cleanup
      await pool.query(`UPDATE catalog_ingestion_jobs SET status = 'completed' WHERE id = $1`, [jobId]);
      await pool.query(`DELETE FROM catalog_ingestion_jobs WHERE id = $1`, [jobId]);
    });

    it('expired lease can be reclaimed by new job', async () => {
      const staleJobId = '80000000-0000-0000-0000-000000000001';
      // Insert a job with expired lease
      await pool.query(
        `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner,
                 lease_expires_at, heartbeat_at)
         VALUES ($1, 'ss', 'running', 'dead-worker',
                 CURRENT_TIMESTAMP - INTERVAL '60 seconds', CURRENT_TIMESTAMP - INTERVAL '120 seconds')`,
        [staleJobId]
      );

      // Reclaim expired jobs (simulate what acquireJobLease does)
      const reclaimed = await pool.query(
        `UPDATE catalog_ingestion_jobs
         SET status = 'rejected',
             completed_at = CURRENT_TIMESTAMP,
             error_summary = 'Stale lease reclaimed'
         WHERE vendor = 'ss'
           AND status IN ('queued', 'running', 'validating')
           AND lease_expires_at < CURRENT_TIMESTAMP
         RETURNING id`
      );
      expect(reclaimed.rows).toHaveLength(1);
      expect((reclaimed.rows[0] as { id: string }).id).toBe(staleJobId);

      // Now a new job should succeed
      const newJobId = '80000000-0000-0000-0000-000000000002';
      await pool.query(
        `INSERT INTO catalog_ingestion_jobs (id, vendor, status, lease_owner,
                 lease_expires_at, heartbeat_at)
         VALUES ($1, 'ss', 'queued', 'new-worker',
                 CURRENT_TIMESTAMP + INTERVAL '600 seconds', CURRENT_TIMESTAMP)`,
        [newJobId]
      );

      // Verify old job is rejected
      const oldJob = await pool.query(
        `SELECT status, error_summary FROM catalog_ingestion_jobs WHERE id = $1`,
        [staleJobId]
      );
      expect((oldJob.rows[0] as any).status).toBe('rejected');
      expect((oldJob.rows[0] as any).error_summary).toContain('Stale lease');

      // Cleanup
      await pool.query(`UPDATE catalog_ingestion_jobs SET status = 'completed' WHERE id = $1`, [newJobId]);
      await pool.query(`DELETE FROM catalog_ingestion_jobs WHERE id IN ($1, $2)`, [staleJobId, newJobId]);
    });

    it('flushes pending SanMar parent styles before full child variant batches', async () => {
      const previousImportId = '90000000-0000-0000-0000-000000000001';
      const tempDir = await mkdtemp(join(tmpdir(), 'sanmar-ingestion-'));
      tempDirs.push(tempDir);
      const epddPath = join(tempDir, 'epdd.csv');
      const dipPath = join(tempDir, 'dip.txt');

      await writeFile(epddPath, EPDD_VALID_CONTENT, 'utf8');
      await writeFile(dipPath, DIP_VALID_CONTENT, 'utf8');

      await pool.query(
        `INSERT INTO catalog_imports (
           id, vendor, status, source_status, source_errors,
           style_count, variant_count, invalid_price_count
         ) VALUES ($1, 'sanmar', 'active', 'direct', 0, 2, 5, 0)`,
        [previousImportId]
      );
      await pool.query(
        `INSERT INTO active_catalog_versions (vendor, import_id)
         VALUES ('sanmar', $1)`,
        [previousImportId]
      );
      await pool.query(
        `INSERT INTO catalog_styles (
           import_id, id, vendor, source_style_id, style_code, brand, name,
           category, description, image_url, active_variant_count, source_sync_at
         ) VALUES
           ($1, 'sanmar:K500', 'sanmar', 'K500', 'K500', 'Port Authority',
            'Prior Silk Touch Polo', 'Polos', 'Prior baseline', NULL, 3, NULL),
           ($1, 'sanmar:PC61', 'sanmar', 'PC61', 'PC61', 'Port & Company',
            'Prior Essential Tee', 'T-Shirts', 'Prior baseline', NULL, 2, NULL)`,
        [previousImportId]
      );
      await pool.query(
        `INSERT INTO catalog_variants (
           import_id, id, style_id, vendor, source_variant_id, style_code,
           color, size, size_order, inventory_qty, image_url, discontinued,
           piece_price, dozen_price, case_price, sale_price, customer_price,
           resolved_cost, cost_basis, source_sync_at
         ) VALUES
           ($1, 'sanmar:K500-BLK-M', 'sanmar:K500', 'sanmar', 'K500-BLK-M', 'K500',
            'Black', 'M', NULL, 1, NULL, FALSE, 11.00, NULL, NULL, NULL, NULL, 11.00, 'piecePrice', NULL),
           ($1, 'sanmar:K500-BLK-L', 'sanmar:K500', 'sanmar', 'K500-BLK-L', 'K500',
            'Black', 'L', NULL, 1, NULL, FALSE, 11.00, NULL, NULL, NULL, NULL, 11.00, 'piecePrice', NULL),
           ($1, 'sanmar:K500-RED-S', 'sanmar:K500', 'sanmar', 'K500-RED-S', 'K500',
            'Red', 'S', NULL, 1, NULL, FALSE, 11.00, NULL, NULL, NULL, NULL, 11.00, 'piecePrice', NULL),
           ($1, 'sanmar:PC61-NVY-M', 'sanmar:PC61', 'sanmar', 'PC61-NVY-M', 'PC61',
            'Navy', 'M', NULL, 1, NULL, FALSE, 4.50, NULL, NULL, NULL, NULL, 4.50, 'piecePrice', NULL),
           ($1, 'sanmar:PC61-NVY-L', 'sanmar:PC61', 'sanmar', 'PC61-NVY-L', 'PC61',
            'Navy', 'L', NULL, 1, NULL, TRUE, 4.50, NULL, NULL, NULL, NULL, 4.50, 'piecePrice', NULL)`,
        [previousImportId]
      );

      const beforePointer = await pool.query(
        `SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar'`
      );
      expect((beforePointer.rows[0] as { import_id: string }).import_id).toBe(previousImportId);

      const result = await runIngestion({
        vendor: 'sanmar',
        target: pool,
        sourceConfig: { type: 'sanmar-local', epddPath, dipPath },
        batchSize: 2,
        leaseOwner: 'sanmar-parent-before-child-regression',
      }) as IngestionResult;

      expect(result.activated).toBe(true);
      expect(result.importId).not.toBe(previousImportId);
      expect(result.styleCount).toBe(2);
      expect(result.variantCount).toBe(5);

      const checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar') AS active_import_id,
           (SELECT status FROM catalog_imports WHERE id = $1) AS previous_status,
           (SELECT status FROM catalog_imports WHERE id = $2) AS current_status,
           (SELECT count(*)::int FROM catalog_styles WHERE import_id = $2) AS styles,
           (SELECT count(*)::int FROM catalog_variants WHERE import_id = $2) AS variants,
           (SELECT count(*)::int FROM catalog_variants v
             LEFT JOIN catalog_styles s
               ON s.import_id = v.import_id AND s.id = v.style_id
             WHERE v.import_id = $2 AND s.id IS NULL) AS orphans,
           (SELECT status FROM catalog_ingestion_jobs WHERE id = $3) AS job_status`,
        [previousImportId, result.importId, result.jobId]
      );
      const row = checks.rows[0] as {
        active_import_id: string;
        previous_status: string;
        current_status: string;
        styles: number;
        variants: number;
        orphans: number;
        job_status: string;
      };

      expect(row.active_import_id).toBe(result.importId);
      expect(row.active_import_id).not.toBe(beforePointer.rows[0].import_id);
      expect(row.previous_status).toBe('superseded');
      expect(row.current_status).toBe('active');
      expect(row.styles).toBe(2);
      expect(row.variants).toBe(5);
      expect(row.orphans).toBe(0);
      expect(row.job_status).toBe('completed');
    });

    it('activates SanMar SOAP into PostgreSQL with null inventory, source timestamps, and server-side costs', async () => {
      await resetVendor('sanmar');
      const previousImportId = await seedActiveBaseline('sanmar', { styles: 1, variants: 2 });

      const result = await runIngestion({
        vendor: 'sanmar',
        target: pool,
        sourceConfig: {
          type: 'sanmar-soap', customerNumber: 'customer', username: 'user', password: 'password',
          styleIds: ['K500'], since: null,
        },
        fetch: sanmarSoapFetchFixture(),
        sleep: async () => {},
        batchSize: 1,
        leaseOwner: 'sanmar-soap-success-owner',
      }) as IngestionResult;

      const checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar') AS active_import_id,
           (SELECT status FROM catalog_imports WHERE id = $1) AS previous_status,
           (SELECT status FROM catalog_imports WHERE id = $2) AS current_status,
           (SELECT count(*)::int FROM catalog_styles WHERE import_id = $2) AS styles,
           (SELECT count(*)::int FROM catalog_variants WHERE import_id = $2) AS variants,
           (SELECT count(*)::int FROM catalog_variants WHERE import_id = $2 AND inventory_qty IS NOT NULL) AS inventory_rows,
           (SELECT count(*)::int FROM catalog_variants WHERE import_id = $2 AND source_sync_at IS NULL) AS missing_sync_times,
           (SELECT count(*)::int FROM catalog_variants v
             LEFT JOIN catalog_styles s ON s.import_id = v.import_id AND s.id = v.style_id
             WHERE v.import_id = $2 AND s.id IS NULL) AS orphans`,
        [previousImportId, result.importId]
      );
      const row = checks.rows[0] as any;
      expect(result.activated).toBe(true);
      expect(row.active_import_id).toBe(result.importId);
      expect(row.previous_status).toBe('superseded');
      expect(row.current_status).toBe('active');
      expect(row.styles).toBe(1);
      expect(row.variants).toBe(2);
      expect(row.inventory_rows).toBe(0);
      expect(row.missing_sync_times).toBe(0);
      expect(row.orphans).toBe(0);

      const styles = await repo().searchStyles({ query: 'K500', vendor: 'sanmar' });
      expect(Object.keys(styles[0]).join(' ')).not.toMatch(/cost|price|cogs/i);
      const variants = await repo().getStyleVariants(styles[0].id);
      expect(variants).toHaveLength(2);
      expect(Object.keys(variants[0]).join(' ')).not.toMatch(/cost|price|cogs/i);
      const cost = await repo().resolveVariantCost('sanmar:208283');
      expect(cost?.unitCost).toBe(9.3);
      expect(cost?.costBasis).toBe('casePrice');
    });

    it('rejects a SanMar SOAP fault, cleans staging, and preserves the prior pointer', async () => {
      await resetVendor('sanmar');
      const previousImportId = await seedActiveBaseline('sanmar', { styles: 1, variants: 2 });

      await expect(runIngestion({
        vendor: 'sanmar',
        target: pool,
        sourceConfig: {
          type: 'sanmar-soap', customerNumber: 'customer', username: 'user', password: 'password',
          styleIds: ['K500'], since: null,
        },
        fetch: sanmarSoapFetchFixture(SANMAR_SOAP_FAULT_RESPONSE),
        sleep: async () => {},
        batchSize: 1,
        leaseOwner: 'sanmar-soap-fault-owner',
      })).rejects.toThrow(/SOAP fault/i);

      const checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar') AS active_import_id,
           (SELECT count(*)::int FROM catalog_styles s
             JOIN catalog_imports i ON i.id = s.import_id
             WHERE i.vendor = 'sanmar' AND i.status <> 'active') AS staged_styles,
           (SELECT count(*)::int FROM catalog_variants v
             JOIN catalog_imports i ON i.id = v.import_id
             WHERE i.vendor = 'sanmar' AND i.status <> 'active') AS staged_variants,
           (SELECT error_summary FROM catalog_ingestion_jobs
             WHERE vendor = 'sanmar' ORDER BY created_at DESC LIMIT 1) AS error_summary`
      );
      expect(checks.rows[0].active_import_id).toBe(previousImportId);
      expect(checks.rows[0].staged_styles).toBe(0);
      expect(checks.rows[0].staged_variants).toBe(0);
      expect(checks.rows[0].error_summary).not.toMatch(/customer|password|response_body_sentinel/i);
    });

    it('rejects SanMar full activation when post-validation drift breaks the case-price invariant', async () => {
      await resetVendor('sanmar');
      const previousImportId = await seedActiveBaseline('sanmar', { styles: 1, variants: 2 });

      await expect(runIngestion({
        vendor: 'sanmar',
        target: pool,
        sourceConfig: {
          type: 'sanmar-soap',
          customerNumber: 'customer',
          username: 'user',
          password: 'password',
          styleIds: ['K500'],
          since: null,
        },
        fetch: sanmarSoapFetchFixture(),
        sleep: async () => {},
        batchSize: 10,
        leaseOwner: 'sanmar-full-invariant-drift-owner',
        testHooks: {
          beforeActivation: async ({ importId }: { importId: string }) => {
            await pool.query(
              `UPDATE catalog_variants
               SET resolved_cost = case_price + 1
               WHERE import_id = $1 AND vendor = 'sanmar'`,
              [importId]
            );
          },
        },
      })).rejects.toThrow(/case-price invariant/i);

      const latest = await pool.query(
        `SELECT import_id, status, error_summary
         FROM catalog_ingestion_jobs
         WHERE vendor = 'sanmar'
         ORDER BY created_at DESC
         LIMIT 1`
      );
      const checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar') AS active_import_id,
           (SELECT status FROM catalog_imports WHERE id = $1) AS import_status,
           (SELECT count(*)::int FROM catalog_styles WHERE import_id = $1) AS staged_styles,
           (SELECT count(*)::int FROM catalog_variants WHERE import_id = $1) AS staged_variants`,
        [latest.rows[0].import_id]
      );

      expect(latest.rows[0].status).toBe('rejected');
      expect(latest.rows[0].error_summary).toMatch(/case-price invariant/i);
      expect(checks.rows[0].active_import_id).toBe(previousImportId);
      expect(checks.rows[0].import_status).toBe('rejected');
      expect(checks.rows[0].staged_styles).toBe(0);
      expect(checks.rows[0].staged_variants).toBe(0);
    });

    async function expectSanMarPostValidationDriftRejected(
      leaseOwner: string,
      beforeActivation: ({ importId }: { importId: string }) => Promise<void>
    ) {
      await resetVendor('sanmar');
      const previousImportId = await seedActiveBaseline('sanmar', { styles: 1, variants: 2 });

      await expect(runIngestion({
        vendor: 'sanmar',
        target: pool,
        sourceConfig: {
          type: 'sanmar-soap',
          customerNumber: 'customer',
          username: 'user',
          password: 'password',
          styleIds: ['K500'],
          since: null,
        },
        fetch: sanmarSoapFetchFixture(),
        sleep: async () => {},
        batchSize: 10,
        leaseOwner,
        testHooks: { beforeActivation },
      })).rejects.toThrow(/case-price invariant/i);

      const latest = await pool.query(
        `SELECT import_id, status, error_summary
         FROM catalog_ingestion_jobs
         WHERE vendor = 'sanmar'
         ORDER BY created_at DESC
         LIMIT 1`
      );
      const checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar') AS active_import_id,
           (SELECT status FROM catalog_imports WHERE id = $1) AS import_status,
           (SELECT count(*)::int FROM catalog_styles WHERE import_id = $1) AS staged_styles,
           (SELECT count(*)::int FROM catalog_variants WHERE import_id = $1) AS staged_variants`,
        [latest.rows[0].import_id]
      );

      expect(latest.rows[0].status).toBe('rejected');
      expect(latest.rows[0].error_summary).toMatch(/case-price invariant/i);
      expect(checks.rows[0].active_import_id).toBe(previousImportId);
      expect(checks.rows[0].import_status).toBe('rejected');
      expect(checks.rows[0].staged_styles).toBe(0);
      expect(checks.rows[0].staged_variants).toBe(0);

      return latest.rows[0].import_id as string;
    }

    it('rejects SanMar activation when post-validation drift deletes one staged variant', async () => {
      await expectSanMarPostValidationDriftRejected(
        'sanmar-delete-one-variant-drift-owner',
        async ({ importId }) => {
          await pool.query(
            `DELETE FROM catalog_variants
             WHERE import_id = $1
               AND id = (
                 SELECT id
                 FROM catalog_variants
                 WHERE import_id = $1
                 ORDER BY id
                 LIMIT 1
               )`,
            [importId]
          );
        }
      );
    });

    it('rejects SanMar activation when post-validation drift deletes all staged variants', async () => {
      await expectSanMarPostValidationDriftRejected(
        'sanmar-delete-all-variants-drift-owner',
        async ({ importId }) => {
          await pool.query(`DELETE FROM catalog_variants WHERE import_id = $1`, [importId]);
        }
      );
    });

    it('rejects SanMar activation when post-validation drift relabels a staged variant away from SanMar', async () => {
      let driftedImportId: string | null = null;
      let droppedVendorFk = false;

      try {
        await expectSanMarPostValidationDriftRejected(
          'sanmar-relabel-variant-drift-owner',
          async ({ importId }) => {
            driftedImportId = importId;
            await pool.query(
              `ALTER TABLE catalog_variants
               DROP CONSTRAINT catalog_variants_import_id_vendor_fkey`
            );
            droppedVendorFk = true;
            await pool.query(
              `UPDATE catalog_variants
               SET vendor = 'ss'
               WHERE import_id = $1
                 AND id = (
                   SELECT id
                   FROM catalog_variants
                   WHERE import_id = $1
                   ORDER BY id
                   LIMIT 1
                 )`,
              [importId]
            );
          }
        );
      } finally {
        if (droppedVendorFk) {
          if (driftedImportId) {
            await pool.query(
              `UPDATE catalog_variants
               SET vendor = 'sanmar'
               WHERE import_id = $1 AND vendor <> 'sanmar'`,
              [driftedImportId]
            ).catch(() => {});
          }
          await pool.query(
            `ALTER TABLE catalog_variants
             ADD CONSTRAINT catalog_variants_import_id_vendor_fkey
             FOREIGN KEY (import_id, vendor)
             REFERENCES catalog_imports(id, vendor)
             ON DELETE CASCADE`
          );
        }
      }
    });

    it('runIngestion activates S&S fixtures, supersedes prior active import, has no orphans, and keeps costs server-side', async () => {
      await resetVendor('ss');
      const previousImportId = await seedActiveBaseline('ss', { styles: 3, variants: 5 });

      const result = await runIngestion({
        vendor: 'ss',
        target: pool,
        sourceConfig: { type: 'ss-api', accountNumber: 'acct', apiKey: 'api-key' },
        fetch: ssFetchFixture(),
        sleep: async () => {},
        batchSize: 2,
        leaseOwner: 'ss-success-owner',
      }) as IngestionResult;

      const checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'ss') AS active_import_id,
           (SELECT status FROM catalog_imports WHERE id = $1) AS previous_status,
           (SELECT status FROM catalog_imports WHERE id = $2) AS current_status,
           (SELECT count(*)::int FROM catalog_styles WHERE import_id = $2) AS styles,
           (SELECT count(*)::int FROM catalog_variants WHERE import_id = $2) AS variants,
           (SELECT count(*)::int FROM catalog_variants v
             LEFT JOIN catalog_styles s
               ON s.import_id = v.import_id AND s.id = v.style_id
             WHERE v.import_id = $2 AND s.id IS NULL) AS orphans,
           (SELECT status FROM catalog_ingestion_jobs WHERE id = $3) AS job_status`,
        [previousImportId, result.importId, result.jobId]
      );
      const row = checks.rows[0] as any;
      expect(result.activated).toBe(true);
      expect(row.active_import_id).toBe(result.importId);
      expect(row.previous_status).toBe('superseded');
      expect(row.current_status).toBe('active');
      expect(row.styles).toBe(3);
      expect(row.variants).toBe(5);
      expect(row.orphans).toBe(0);
      expect(row.job_status).toBe('completed');

      const styles = await repo().searchStyles({ query: '3001', vendor: 'ss' });
      expect(styles[0].styleCode).toBe('3001');
      expect(Object.keys(styles[0]).join(' ')).not.toMatch(/cost|price|cogs/i);
      const variants = await repo().getStyleVariants(styles[0].id);
      expect(variants.length).toBeGreaterThan(0);
      expect(Object.keys(variants[0]).join(' ')).not.toMatch(/cost|price|cogs/i);
      const cost = await repo().resolveVariantCost('ss:SS-3001-BLK-M');
      expect(cost?.unitCost).toBe(5.50);
      expect(cost?.costBasis).toBe('piecePrice');
    });

    it('activates operator-pinned S&S confirmed-empty styles as unavailable with audit metadata', async () => {
      await resetVendor('ss');
      const previousImportId = await seedActiveBaseline('ss', { styles: 3, variants: 5 });
      const emptyStyle = {
        ...SS_STYLES_RESPONSE[2],
        styleID: 103,
        styleName: '3001C',
      };
      const styles = [SS_STYLES_RESPONSE[0], SS_STYLES_RESPONSE[1], emptyStyle];
      const products = SS_PRODUCTS_BATCH_1;
      const digest = ssEmptyStyleDigest(['103']);

      const result = await runIngestion({
        vendor: 'ss',
        target: pool,
        sourceConfig: {
          type: 'ss-api',
          accountNumber: 'acct',
          apiKey: 'api-key',
          expectedEmptyStylePins: {
            styleCount: 3,
            variantCount: 4,
            emptyStyleSha256: digest,
          },
        },
        fetch: ssFetchFixture({ styles, products }),
        sleep: async () => {},
        batchSize: 2,
        leaseOwner: 'ss-empty-style-exception-owner',
      }) as IngestionResult;

      const checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'ss') AS active_import_id,
           (SELECT status FROM catalog_imports WHERE id = $1) AS previous_status,
           (SELECT status FROM catalog_imports WHERE id = $2) AS current_status,
           (SELECT source_errors FROM catalog_imports WHERE id = $2) AS import_source_errors,
           (SELECT invalid_price_count FROM catalog_imports WHERE id = $2) AS invalid_price_count,
           (SELECT source_metadata FROM catalog_imports WHERE id = $2) AS source_metadata,
           (SELECT checkpoint FROM catalog_ingestion_jobs WHERE id = $3) AS checkpoint,
           (SELECT active_variant_count FROM active_catalog_styles WHERE vendor = 'ss' AND source_style_id = '103') AS empty_active_variants,
           (SELECT count(*)::int
              FROM active_catalog_variants v
              JOIN active_catalog_styles s ON s.id = v.style_id AND s.import_id = v.import_id
             WHERE v.vendor = 'ss' AND s.source_style_id = '103') AS empty_variant_rows,
           (SELECT count(*)::int FROM active_catalog_variants WHERE vendor = 'ss' AND cost_basis = 'piecePrice' AND piece_price > 0 AND resolved_cost = piece_price) AS valid_piece_rows`,
        [previousImportId, result.importId, result.jobId]
      );
      const row = checks.rows[0] as any;
      const sourceMetadata = row.source_metadata.ssEmptyStyleActivationException;
      const checkpointException = row.checkpoint.ssEmptyStyleActivationException;

      expect(result.activated).toBe(true);
      expect(result.styleCount).toBe(3);
      expect(result.variantCount).toBe(4);
      expect(result.skippedCount).toBe(0);
      expect(row.active_import_id).toBe(result.importId);
      expect(row.previous_status).toBe('superseded');
      expect(row.current_status).toBe('active');
      expect(Number(row.import_source_errors)).toBe(0);
      expect(Number(row.invalid_price_count)).toBe(0);
      expect(Number(row.empty_active_variants)).toBe(0);
      expect(Number(row.empty_variant_rows)).toBe(0);
      expect(Number(row.valid_piece_rows)).toBe(4);
      expect(sourceMetadata).toMatchObject({
        accepted: true,
        expectedStyleCount: 3,
        expectedVariantCount: 4,
        emptyStyleCount: 1,
        emptyStyleSha256: digest,
        emptyStyleIds: ['103'],
      });
      expect(checkpointException).toEqual(sourceMetadata);
    });

    it('keeps activated data intact after a post-activation failure and cleans a pre-activation failure', async () => {
      await resetVendor('ss');
      let previousImportId = await seedActiveBaseline('ss', { styles: 3, variants: 5 });

      await expect(runIngestion({
        vendor: 'ss',
        target: pool,
        sourceConfig: { type: 'ss-api', accountNumber: 'acct', apiKey: 'api-key' },
        fetch: ssFetchFixture(),
        sleep: async () => {},
        batchSize: 2,
        leaseOwner: 'ss-post-activation-fault-owner',
        testHooks: {
          afterActivation: async () => {
            throw new Error('post-activation reporting failure');
          },
        },
      })).rejects.toThrow(/post-activation reporting failure/);

      let latest = await pool.query(
        `SELECT id, import_id, status, completed_at, checkpoint
         FROM catalog_ingestion_jobs
         WHERE vendor = 'ss'
         ORDER BY created_at DESC
         LIMIT 1`
      );
      let activatedImportId = latest.rows[0].import_id;
      let checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'ss') AS active_import_id,
           (SELECT status FROM catalog_imports WHERE id = $1) AS previous_status,
           (SELECT status FROM catalog_imports WHERE id = $2) AS active_status,
           (SELECT count(*)::int FROM catalog_styles WHERE import_id = $2) AS styles,
           (SELECT count(*)::int FROM catalog_variants WHERE import_id = $2) AS variants,
           (SELECT count(*)::int FROM active_catalog_styles WHERE vendor = 'ss') AS active_styles,
           (SELECT count(*)::int FROM active_catalog_variants WHERE vendor = 'ss') AS active_variants`,
        [previousImportId, activatedImportId]
      );
      expect(latest.rows[0].status).toBe('completed');
      expect(latest.rows[0].completed_at).not.toBeNull();
      expect(latest.rows[0].checkpoint.phase).toBe('completed');
      expect(checks.rows[0].active_import_id).toBe(activatedImportId);
      expect(checks.rows[0].previous_status).toBe('superseded');
      expect(checks.rows[0].active_status).toBe('active');
      expect(checks.rows[0].styles).toBe(3);
      expect(checks.rows[0].variants).toBe(5);
      expect(checks.rows[0].active_styles).toBe(3);
      expect(checks.rows[0].active_variants).toBe(5);

      await resetVendor('ss');
      previousImportId = await seedActiveBaseline('ss', { styles: 3, variants: 5 });
      await expect(runIngestion({
        vendor: 'ss',
        target: pool,
        sourceConfig: { type: 'ss-api', accountNumber: 'acct', apiKey: 'api-key' },
        fetch: ssFetchFixture(),
        sleep: async () => {},
        batchSize: 2,
        leaseOwner: 'ss-pre-activation-fault-owner',
        testHooks: {
          beforeActivation: async () => {
            throw new Error('pre-activation validation/reporting failure');
          },
        },
      })).rejects.toThrow(/pre-activation validation\/reporting failure/);

      latest = await pool.query(
        `SELECT import_id, status
         FROM catalog_ingestion_jobs
         WHERE vendor = 'ss'
         ORDER BY created_at DESC
         LIMIT 1`
      );
      checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'ss') AS active_import_id,
           (SELECT status FROM catalog_imports WHERE id = $1) AS rejected_status,
           (SELECT count(*)::int FROM catalog_styles WHERE import_id = $1) AS staged_styles,
           (SELECT count(*)::int FROM catalog_variants WHERE import_id = $1) AS staged_variants`,
        [latest.rows[0].import_id]
      );
      expect(latest.rows[0].status).toBe('rejected');
      expect(checks.rows[0].active_import_id).toBe(previousImportId);
      expect(checks.rows[0].rejected_status).toBe('rejected');
      expect(checks.rows[0].staged_styles).toBe(0);
      expect(checks.rows[0].staged_variants).toBe(0);
    });

    it('rejects incomplete inputs and count drops without moving the active pointer or leaving staged rows', async () => {
      const cases: Array<{
        name: string;
        vendor: 'ss' | 'sanmar';
        previousCounts: { styles: number; variants: number };
        run: () => Promise<unknown>;
      }> = [];

      await resetVendor('ss');
      let priorImportId = await seedActiveBaseline('ss', { styles: 1, variants: 1 });
      cases.push({
        name: 'price-less S&S',
        vendor: 'ss',
        previousCounts: { styles: 1, variants: 1 },
        run: () => runIngestion({
          vendor: 'ss',
          target: pool,
          sourceConfig: { type: 'ss-api', accountNumber: 'acct', apiKey: 'api-key' },
          fetch: ssFetchFixture({
            styles: [SS_STYLES_RESPONSE[0]],
            products: [SS_PRODUCT_NO_PRICE],
          }),
          sleep: async () => {},
          batchSize: 2,
          leaseOwner: 'ss-priceless-owner',
        }),
      });

      for (const testCase of cases) {
        await expect(testCase.run()).rejects.toThrow();
        const rejected = await pool.query(
          `SELECT import_id, status FROM catalog_ingestion_jobs
           WHERE vendor = $1 ORDER BY created_at DESC LIMIT 1`,
          [testCase.vendor]
        );
        const importId = rejected.rows[0]?.import_id;
        const checks = await pool.query(
          `SELECT
             (SELECT import_id FROM active_catalog_versions WHERE vendor = $1) AS active_import_id,
             (SELECT status FROM catalog_imports WHERE id = $2) AS rejected_status,
             (SELECT count(*)::int FROM catalog_styles WHERE import_id = $2) AS staged_styles,
             (SELECT count(*)::int FROM catalog_variants WHERE import_id = $2) AS staged_variants`,
          [testCase.vendor, importId]
        );
        expect(checks.rows[0].active_import_id).toBe(priorImportId);
        expect(checks.rows[0].rejected_status).toBe('rejected');
        expect(checks.rows[0].staged_styles).toBe(0);
        expect(checks.rows[0].staged_variants).toBe(0);
      }

      await resetVendor('sanmar');
      priorImportId = await seedActiveBaseline('sanmar', { styles: 2, variants: 5 });
      const dipMissingOneKey = `${DIP_HEADERS}
INV001|S01|K500|Black|M|WH1|25|11.00|132.00||||||K500-BLK-M|
INV002|S02|K500|Black|L|WH1|30|11.00|132.00||||||K500-BLK-L|
INV003|S03|K500|Red|S|WH1|0|11.00|132.00||||||K500-RED-S|
INV004|S04|PC61|Navy|M|WH1|100|4.50|54.00||||||PC61-NVY-M|
`;
      const sanmarMissing = await writeSanMarFiles(EPDD_VALID_CONTENT, dipMissingOneKey);
      await expect(runIngestion({
        vendor: 'sanmar',
        target: pool,
        sourceConfig: { type: 'sanmar-local', ...sanmarMissing },
        batchSize: 2,
        leaseOwner: 'sanmar-missing-key-owner',
      })).rejects.toThrow(/incomplete/i);
      let latest = await pool.query(
        `SELECT import_id FROM catalog_ingestion_jobs WHERE vendor = 'sanmar' ORDER BY created_at DESC LIMIT 1`
      );
      let importId = latest.rows[0].import_id;
      let checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar') AS active_import_id,
           (SELECT status FROM catalog_imports WHERE id = $1) AS rejected_status,
           (SELECT count(*)::int FROM catalog_styles WHERE import_id = $1) AS staged_styles,
           (SELECT count(*)::int FROM catalog_variants WHERE import_id = $1) AS staged_variants`,
        [importId]
      );
      expect(checks.rows[0].active_import_id).toBe(priorImportId);
      expect(checks.rows[0].rejected_status).toBe('rejected');
      expect(checks.rows[0].staged_styles).toBe(0);
      expect(checks.rows[0].staged_variants).toBe(0);

      await resetVendor('sanmar');
      priorImportId = await seedActiveBaseline('sanmar', { styles: 2, variants: 5 });
      const malformedEpdd = `${EPDD_HEADERS}
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","12.50","","INV001","S01","Port Authority","Active",""
"","Missing Key","","K500","Polos","Black","L","12.50","","INV002","S02","Port Authority","Active",""
`;
      const sanmarMalformed = await writeSanMarFiles(malformedEpdd, DIP_VALID_CONTENT);
      await expect(runIngestion({
        vendor: 'sanmar',
        target: pool,
        sourceConfig: { type: 'sanmar-local', ...sanmarMalformed },
        batchSize: 2,
        leaseOwner: 'sanmar-malformed-owner',
      })).rejects.toThrow(/incomplete/i);
      latest = await pool.query(
        `SELECT import_id FROM catalog_ingestion_jobs WHERE vendor = 'sanmar' ORDER BY created_at DESC LIMIT 1`
      );
      importId = latest.rows[0].import_id;
      checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar') AS active_import_id,
           (SELECT status FROM catalog_imports WHERE id = $1) AS rejected_status,
           (SELECT count(*)::int FROM catalog_styles WHERE import_id = $1) AS staged_styles,
           (SELECT count(*)::int FROM catalog_variants WHERE import_id = $1) AS staged_variants`,
        [importId]
      );
      expect(checks.rows[0].active_import_id).toBe(priorImportId);
      expect(checks.rows[0].rejected_status).toBe('rejected');
      expect(checks.rows[0].staged_styles).toBe(0);
      expect(checks.rows[0].staged_variants).toBe(0);

      await resetVendor('ss');
      priorImportId = await seedActiveBaseline('ss', { styles: 10, variants: 10 });
      await expect(runIngestion({
        vendor: 'ss',
        target: pool,
        sourceConfig: { type: 'ss-api', accountNumber: 'acct', apiKey: 'api-key' },
        fetch: ssFetchFixture(),
        sleep: async () => {},
        batchSize: 2,
        leaseOwner: 'ss-count-drop-owner',
      })).rejects.toThrow(/dropped more than 20/i);
      latest = await pool.query(
        `SELECT import_id FROM catalog_ingestion_jobs WHERE vendor = 'ss' ORDER BY created_at DESC LIMIT 1`
      );
      importId = latest.rows[0].import_id;
      checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'ss') AS active_import_id,
           (SELECT status FROM catalog_imports WHERE id = $1) AS rejected_status,
           (SELECT count(*)::int FROM catalog_styles WHERE import_id = $1) AS staged_styles,
           (SELECT count(*)::int FROM catalog_variants WHERE import_id = $1) AS staged_variants`,
        [importId]
      );
      expect(checks.rows[0].active_import_id).toBe(priorImportId);
      expect(checks.rows[0].rejected_status).toBe('rejected');
      expect(checks.rows[0].staged_styles).toBe(0);
      expect(checks.rows[0].staged_variants).toBe(0);
    });

    it('cancels during DB flush, cleans staging, and preserves the prior active import', async () => {
      await resetVendor('ss');
      const priorImportId = await seedActiveBaseline('ss', { styles: 3, variants: 5 });
      let canceled = false;

      await expect(runIngestion({
        vendor: 'ss',
        target: pool,
        sourceConfig: { type: 'ss-api', accountNumber: 'acct', apiKey: 'api-key' },
        fetch: ssFetchFixture(),
        sleep: async () => {},
        batchSize: 2,
        leaseOwner: 'ss-cancel-owner',
        testHooks: {
          beforeVariantFlush: async ({ jobId }: { jobId: string }) => {
            if (canceled) return;
            canceled = true;
            await pool.query(`UPDATE catalog_ingestion_jobs SET cancel_requested = TRUE WHERE id = $1`, [jobId]);
          },
        },
      })).rejects.toMatchObject({ category: 'canceled' });

      const checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'ss') AS active_import_id,
           j.import_id,
           j.status,
           (SELECT count(*)::int FROM catalog_styles WHERE import_id = j.import_id) AS staged_styles,
           (SELECT count(*)::int FROM catalog_variants WHERE import_id = j.import_id) AS staged_variants
         FROM catalog_ingestion_jobs j
         WHERE j.vendor = 'ss'
         ORDER BY j.created_at DESC
         LIMIT 1`
      );
      expect(checks.rows[0].active_import_id).toBe(priorImportId);
      expect(checks.rows[0].status).toBe('canceled');
      expect(checks.rows[0].staged_styles).toBe(0);
      expect(checks.rows[0].staged_variants).toBe(0);
    });

    it('refuses activation after a stale owner loses the lease before activation', async () => {
      await resetVendor('ss');
      const priorImportId = await seedActiveBaseline('ss', { styles: 3, variants: 5 });

      await expect(runIngestion({
        vendor: 'ss',
        target: pool,
        sourceConfig: { type: 'ss-api', accountNumber: 'acct', apiKey: 'api-key' },
        fetch: ssFetchFixture(),
        sleep: async () => {},
        batchSize: 2,
        leaseOwner: 'old-owner',
        testHooks: {
          beforeActivation: async ({ jobId }: { jobId: string }) => {
            await pool.query(
              `UPDATE catalog_ingestion_jobs
               SET lease_owner = 'new-owner',
                   lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '600 seconds'
               WHERE id = $1`,
              [jobId]
            );
          },
        },
      })).rejects.toMatchObject({ category: 'lost_lease' });

      const checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'ss') AS active_import_id,
           j.import_id,
           j.status,
           j.lease_owner,
           (SELECT count(*)::int FROM catalog_styles WHERE import_id = j.import_id) AS staged_styles,
           (SELECT count(*)::int FROM catalog_variants WHERE import_id = j.import_id) AS staged_variants
         FROM catalog_ingestion_jobs j
         WHERE j.vendor = 'ss'
         ORDER BY j.created_at DESC
         LIMIT 1`
      );
      expect(checks.rows[0].active_import_id).toBe(priorImportId);
      expect(checks.rows[0].lease_owner).toBe('new-owner');
      expect(checks.rows[0].status).toBe('validating');
      expect(checks.rows[0].staged_styles).toBe(0);
      expect(checks.rows[0].staged_variants).toBe(0);
    });

    it('rejects S&S piece-price invariant drift immediately before activation and preserves the active pointer', async () => {
      await resetVendor('ss');
      const priorImportId = await seedActiveBaseline('ss', { styles: 3, variants: 5 });

      await expect(runIngestion({
        vendor: 'ss',
        target: pool,
        sourceConfig: { type: 'ss-api', accountNumber: 'acct', apiKey: 'api-key' },
        fetch: ssFetchFixture(),
        sleep: async () => {},
        batchSize: 2,
        leaseOwner: 'ss-piece-price-invariant-owner',
        testHooks: {
          beforeActivation: async ({ importId }: { importId: string }) => {
            await pool.query(
              `UPDATE catalog_variants
               SET resolved_cost = piece_price - 0.01
               WHERE import_id = $1
                 AND vendor = 'ss'
                 AND id = (
                   SELECT id FROM catalog_variants
                   WHERE import_id = $1 AND vendor = 'ss'
                   ORDER BY id
                   LIMIT 1
                 )`,
              [importId]
            );
          },
        },
      })).rejects.toThrow(/piece price activation invariant/i);

      const checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'ss') AS active_import_id,
           j.import_id,
           j.status,
           (SELECT status FROM catalog_imports WHERE id = j.import_id) AS rejected_status,
           (SELECT count(*)::int FROM catalog_styles WHERE import_id = j.import_id) AS staged_styles,
           (SELECT count(*)::int FROM catalog_variants WHERE import_id = j.import_id) AS staged_variants
         FROM catalog_ingestion_jobs j
         WHERE j.vendor = 'ss'
         ORDER BY j.created_at DESC
         LIMIT 1`
      );
      expect(checks.rows[0].active_import_id).toBe(priorImportId);
      expect(checks.rows[0].status).toBe('rejected');
      expect(checks.rows[0].rejected_status).toBe('rejected');
      expect(checks.rows[0].staged_styles).toBe(0);
      expect(checks.rows[0].staged_variants).toBe(0);
    });

    async function expectSSPostValidationDriftRejected(
      leaseOwner: string,
      beforeActivation: ({ importId }: { importId: string }) => Promise<void>
    ) {
      await resetVendor('ss');
      const priorImportId = await seedActiveBaseline('ss', { styles: 3, variants: 5 });

      await expect(runIngestion({
        vendor: 'ss',
        target: pool,
        sourceConfig: { type: 'ss-api', accountNumber: 'acct', apiKey: 'api-key' },
        fetch: ssFetchFixture(),
        sleep: async () => {},
        batchSize: 2,
        leaseOwner,
        testHooks: { beforeActivation },
      })).rejects.toThrow(/piece price activation invariant/i);

      const checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'ss') AS active_import_id,
           j.import_id,
           j.status,
           j.error_summary,
           (SELECT status FROM catalog_imports WHERE id = j.import_id) AS rejected_status,
           (SELECT count(*)::int FROM catalog_styles WHERE import_id = j.import_id) AS staged_styles,
           (SELECT count(*)::int FROM catalog_variants WHERE import_id = j.import_id) AS staged_variants
         FROM catalog_ingestion_jobs j
         WHERE j.vendor = 'ss'
         ORDER BY j.created_at DESC
         LIMIT 1`
      );
      expect(checks.rows[0].active_import_id).toBe(priorImportId);
      expect(checks.rows[0].status).toBe('rejected');
      expect(checks.rows[0].error_summary).toMatch(/piece price activation invariant/i);
      expect(checks.rows[0].rejected_status).toBe('rejected');
      expect(checks.rows[0].staged_styles).toBe(0);
      expect(checks.rows[0].staged_variants).toBe(0);

      return checks.rows[0].import_id as string;
    }

    it('rejects S&S activation when post-validation drift deletes one staged variant', async () => {
      await expectSSPostValidationDriftRejected(
        'ss-delete-one-variant-drift-owner',
        async ({ importId }) => {
          await pool.query(
            `DELETE FROM catalog_variants
             WHERE import_id = $1
               AND id = (
                 SELECT id
                 FROM catalog_variants
                 WHERE import_id = $1
                 ORDER BY id
                 LIMIT 1
               )`,
            [importId]
          );
        }
      );
    });

    it('rejects S&S activation when post-validation drift deletes all staged variants', async () => {
      await expectSSPostValidationDriftRejected(
        'ss-delete-all-variants-drift-owner',
        async ({ importId }) => {
          await pool.query(`DELETE FROM catalog_variants WHERE import_id = $1`, [importId]);
        }
      );
    });

    it('rejects S&S activation when post-validation drift relabels a staged variant away from S&S', async () => {
      let driftedImportId: string | null = null;
      let droppedVendorFk = false;

      try {
        await expectSSPostValidationDriftRejected(
          'ss-relabel-variant-drift-owner',
          async ({ importId }) => {
            driftedImportId = importId;
            await pool.query(
              `ALTER TABLE catalog_variants
               DROP CONSTRAINT catalog_variants_import_id_vendor_fkey`
            );
            droppedVendorFk = true;
            await pool.query(
              `UPDATE catalog_variants
               SET vendor = 'sanmar'
               WHERE import_id = $1
                 AND id = (
                   SELECT id
                   FROM catalog_variants
                   WHERE import_id = $1
                   ORDER BY id
                   LIMIT 1
                 )`,
              [importId]
            );
          }
        );
      } finally {
        if (droppedVendorFk) {
          if (driftedImportId) {
            await pool.query(
              `UPDATE catalog_variants
               SET vendor = 'ss'
               WHERE import_id = $1 AND vendor <> 'ss'`,
              [driftedImportId]
            ).catch(() => {});
          }
          await pool.query(
            `ALTER TABLE catalog_variants
             ADD CONSTRAINT catalog_variants_import_id_vendor_fkey
             FOREIGN KEY (import_id, vendor)
             REFERENCES catalog_imports(id, vendor)
             ON DELETE CASCADE`
          );
        }
      }
    });

    it('stores redacted error summaries without auth or response-body sentinels', async () => {
      await resetVendor('ss');
      const priorImportId = await seedActiveBaseline('ss', { styles: 1, variants: 1 });

      await expect(runIngestion({
        vendor: 'ss',
        target: pool,
        sourceConfig: { type: 'ss-api', accountNumber: 'acct', apiKey: 'api-key' },
        fetch: ssFetchFixture({
          throwMessage: 'Basic abc123 Bearer token123 API key supersecret password=hunter2 response_body_sentinel',
        }),
        sleep: async () => {},
        batchSize: 2,
        leaseOwner: 'ss-redaction-owner',
      })).rejects.toThrow();

      const result = await pool.query(
        `SELECT error_summary FROM catalog_ingestion_jobs
         WHERE vendor = 'ss' ORDER BY created_at DESC LIMIT 1`
      );
      const summary = String(result.rows[0].error_summary);
      expect(summary).not.toContain('abc123');
      expect(summary).not.toContain('token123');
      expect(summary).not.toContain('supersecret');
      expect(summary).not.toContain('hunter2');
      expect(summary).not.toContain('response_body_sentinel');
      const pointer = await pool.query(`SELECT import_id FROM active_catalog_versions WHERE vendor = 'ss'`);
      expect(pointer.rows[0].import_id).toBe(priorImportId);
    });
  }
);
