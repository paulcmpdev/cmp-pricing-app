import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { VENDOR_CATALOG_POSTGRES_SCHEMA_SQL } from '../../lib/server/vendor-catalog/postgres-schema.mjs';
import { runDeltaIngestion } from '../sync-vendor-catalog.mjs';
import {
  SANMAR_SOAP_PRODUCT_RESPONSE,
  SANMAR_SOAP_NOT_FOUND_RESPONSE,
} from '../../tests/fixtures/vendor-sources/sanmar-soap-fixtures.mjs';

const TEST_PG_URL = process.env.VENDOR_CATALOG_TEST_DATABASE_URL;
const runIntegration = TEST_PG_URL != null && TEST_PG_URL.length > 0;

const SCHEMA_NAME = `test_delta_int_${process.pid}_${randomUUID().replaceAll('-', '_')}`;

function response(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/xml' },
  });
}

// Discovery response returning K500 as modified
const DISCOVERY_K500 = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetProductDateModifiedResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><ProductDateModifiedArray><ProductDateModified><productId>K500</productId><partId>1</partId></ProductDateModified></ProductDateModifiedArray></ns2:GetProductDateModifiedResponse></S:Body></S:Envelope>`;

// Discovery response returning nothing modified
const DISCOVERY_EMPTY = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetProductDateModifiedResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><ProductDateModifiedArray/></ns2:GetProductDateModifiedResponse></S:Body></S:Envelope>`;

// Discovery response returning a style that will be confirmed unavailable
const DISCOVERY_REMOVED = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetProductDateModifiedResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><ProductDateModifiedArray><ProductDateModified><productId>2700</productId><partId>1</partId></ProductDateModified></ProductDateModifiedArray></ns2:GetProductDateModifiedResponse></S:Body></S:Envelope>`;

const DISCOVERY_TWO_REMOVED = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetProductDateModifiedResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><ProductDateModifiedArray><ProductDateModified><productId>2700</productId><partId>1</partId></ProductDateModified><ProductDateModified><productId>2701</productId><partId>2</partId></ProductDateModified></ProductDateModifiedArray></ns2:GetProductDateModifiedResponse></S:Body></S:Envelope>`;

// Discovery with both modified and removed
const DISCOVERY_MIXED = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetProductDateModifiedResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><ProductDateModifiedArray><ProductDateModified><productId>K500</productId><partId>1</partId></ProductDateModified><ProductDateModified><productId>2700</productId><partId>2</partId></ProductDateModified></ProductDateModifiedArray></ns2:GetProductDateModifiedResponse></S:Body></S:Envelope>`;

// Product error response (triggers code-130 lookup)
const PRODUCT_ERROR = `<?xml version="1.0" encoding="UTF-8"?>
<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/">
  <S:Body>
    <ns2:getProductInfoByStyleColorSizeResponse xmlns:ns2="http://impl.webservice.integration.sanmar.com/">
      <return>
        <errorOccured>true</errorOccured>
        <message>ERROR: Internal error occurred.</message>
      </return>
    </ns2:getProductInfoByStyleColorSizeResponse>
  </S:Body>
</S:Envelope>`;

type DeltaResult = {
  activated: boolean;
  importId: string;
  jobId: string;
  styleCount: number;
  variantCount: number;
  mode: string;
  baseImportId: string;
  modifiedStyleCount: number;
  patchedStyleCount: number;
  removedStyleCount: number;
};

describe.skipIf(!runIntegration)(
  'delta ingestion integration',
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

    async function resetVendor() {
      await pool.query(`DELETE FROM active_catalog_versions WHERE vendor = 'sanmar'`);
      await pool.query(`DELETE FROM catalog_ingestion_jobs WHERE vendor = 'sanmar'`);
      await pool.query(`DELETE FROM catalog_imports WHERE vendor = 'sanmar'`);
    }

    async function seedActiveImport(styles: Array<{
      sourceStyleId: string;
      styleCode: string;
      brand: string;
      variants: Array<{
        sourceVariantId: string;
        color: string;
        size: string;
        piecePrice: number;
      }>;
    }>) {
      const importId = randomUUID();
      let styleCount = 0;
      let variantCount = 0;

      await pool.query(
        `INSERT INTO catalog_imports (
           id, vendor, status, source_status, source_errors,
           style_count, variant_count, invalid_price_count, activated_at, content_hash
         ) VALUES ($1, 'sanmar', 'active', 'direct', 0, 0, 0, 0, CURRENT_TIMESTAMP, 'seed')`,
        [importId]
      );

      for (const style of styles) {
        const id = `sanmar:${style.sourceStyleId}`;
        styleCount++;
        await pool.query(
          `INSERT INTO catalog_styles (
             import_id, id, vendor, source_style_id, style_code, brand, name,
             category, description, image_url, active_variant_count, source_sync_at
           ) VALUES ($1, $2, 'sanmar', $3, $4, $5, $6, 'Test', NULL, NULL, $7,
                     '2026-08-20T00:00:00Z')`,
          [importId, id, style.sourceStyleId, style.styleCode,
           style.brand, `${style.brand} ${style.styleCode}`, style.variants.length]
        );
        for (const v of style.variants) {
          variantCount++;
          await pool.query(
            `INSERT INTO catalog_variants (
               import_id, id, style_id, vendor, source_variant_id, style_code,
               color, size, size_order, inventory_qty, image_url, discontinued,
               piece_price, dozen_price, case_price, sale_price, customer_price,
               resolved_cost, cost_basis, source_sync_at
             ) VALUES ($1, $2, $3, 'sanmar', $4, $5, $6, $7, NULL, NULL, NULL, FALSE,
                       $8, NULL, NULL, NULL, NULL, $8, 'piecePrice',
                       '2026-08-20T00:00:00Z')`,
            [importId, `sanmar:${v.sourceVariantId}`, id,
             v.sourceVariantId, style.styleCode, v.color, v.size, v.piecePrice]
          );
        }
      }

      await pool.query(
        `UPDATE catalog_imports SET style_count = $2, variant_count = $3 WHERE id = $1`,
        [importId, styleCount, variantCount]
      );
      await pool.query(
        `INSERT INTO active_catalog_versions (vendor, import_id)
         VALUES ('sanmar', $1)
         ON CONFLICT (vendor) DO UPDATE SET import_id = EXCLUDED.import_id, activated_at = CURRENT_TIMESTAMP`,
        [importId]
      );

      return importId;
    }

    function deltaFetch(
      discoveryResponse: string,
      styleResponses: Record<string, { productResponse?: string; lookupResponse?: string }>
    ) {
      return async (url: string, options: { body?: string }) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/promostandards/ProductDataServiceBindingV2') {
          const body = options.body ?? '';
          if (body.includes('GetProductDateModifiedRequest')) {
            return response(discoveryResponse);
          }
          if (body.includes('GetProductRequest')) {
            // Extract productId from request
            const match = body.match(/<shar:productId>([^<]+)<\/shar:productId>/);
            const id = match?.[1];
            const config = id ? styleResponses[id] : undefined;
            if (config?.lookupResponse) return response(config.lookupResponse);
            return response(SANMAR_SOAP_NOT_FOUND_RESPONSE);
          }
        }
        if (parsed.pathname === '/SanMarWebService/SanMarProductInfoServicePort') {
          const body = options.body ?? '';
          const match = body.match(/<style>([^<]+)<\/style>/);
          const id = match?.[1];
          const config = id ? styleResponses[id] : undefined;
          if (config?.productResponse) return response(config.productResponse);
          return response(SANMAR_SOAP_PRODUCT_RESPONSE);
        }
        return response('', 500);
      };
    }

    it('clones active, patches changed style, preserves unchanged, activates atomically', async () => {
      await resetVendor();
      const baseImportId = await seedActiveImport([
        {
          sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
          variants: [
            { sourceVariantId: '208283', color: 'Black', size: 'M', piecePrice: 10.00 },
            { sourceVariantId: '208284', color: 'Black', size: 'L', piecePrice: 10.00 },
          ],
        },
        {
          sourceStyleId: 'PC61', styleCode: 'PC61', brand: 'Port & Company',
          variants: [
            { sourceVariantId: 'PC61-NVY-M', color: 'Navy', size: 'M', piecePrice: 4.50 },
          ],
        },
      ]);

      const result = await runDeltaIngestion({
        vendor: 'sanmar',
        target: pool,
        sourceConfig: {
          type: 'sanmar-soap-delta',
          customerNumber: 'customer',
          username: 'user',
          password: 'password',
          baseImportId,
          since: '2026-08-20T00:00:00.000Z',
        },
        fetch: deltaFetch(DISCOVERY_K500, {
          K500: { productResponse: SANMAR_SOAP_PRODUCT_RESPONSE },
        }),
        sleep: async () => {},
        batchSize: 10,
        leaseOwner: 'delta-patch-test',
      }) as DeltaResult;

      expect(result.activated).toBe(true);
      expect(result.mode).toBe('delta');
      expect(result.baseImportId).toBe(baseImportId);
      expect(result.modifiedStyleCount).toBe(1);
      expect(result.patchedStyleCount).toBe(1);
      expect(result.removedStyleCount).toBe(0);

      // Complete catalog should have 2 styles (K500 patched + PC61 unchanged)
      expect(result.styleCount).toBe(2);
      // K500 now has 2 variants from SOAP, PC61 has 1 unchanged = 3 total
      expect(result.variantCount).toBe(3);

      // Verify activation
      const checks = await pool.query(
        `SELECT
           (SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar') AS active_id,
           (SELECT status FROM catalog_imports WHERE id = $1) AS base_status,
           (SELECT status FROM catalog_imports WHERE id = $2) AS new_status,
           (SELECT status FROM catalog_ingestion_jobs WHERE id = $3) AS job_status`,
        [baseImportId, result.importId, result.jobId]
      );
      expect(checks.rows[0].active_id).toBe(result.importId);
      expect(checks.rows[0].base_status).toBe('superseded');
      expect(checks.rows[0].new_status).toBe('active');
      expect(checks.rows[0].job_status).toBe('completed');

      // PC61 variant should be preserved with original source_sync_at
      const pc61Variants = await pool.query(
        `SELECT source_sync_at FROM catalog_variants
         WHERE import_id = $1 AND style_code = 'PC61'`,
        [result.importId]
      );
      expect(pc61Variants.rows).toHaveLength(1);
      expect(new Date(pc61Variants.rows[0].source_sync_at).toISOString()).toBe('2026-08-20T00:00:00.000Z');

      // K500 variants should have new source_sync_at (from snapshot timestamp)
      const k500Variants = await pool.query(
        `SELECT source_sync_at FROM catalog_variants
         WHERE import_id = $1 AND style_code = 'K500'`,
        [result.importId]
      );
      expect(k500Variants.rows).toHaveLength(2);
      expect(new Date(k500Variants.rows[0].source_sync_at).toISOString()).not.toBe('2026-08-20T00:00:00.000Z');

      // K500 variant should have updated price from SOAP (11.30 not 10.00)
      const k500Cost = await pool.query(
        `SELECT resolved_cost FROM catalog_variants
         WHERE import_id = $1 AND source_variant_id = '208283'`,
        [result.importId]
      );
      expect(Number(k500Cost.rows[0].resolved_cost)).toBe(11.3);
    });

    it('removes confirmed-unavailable style and preserves rest', async () => {
      await resetVendor();
      const baseImportId = await seedActiveImport([
        {
          sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
          variants: [
            { sourceVariantId: '208283', color: 'Black', size: 'M', piecePrice: 11.30 },
          ],
        },
        {
          sourceStyleId: '2700', styleCode: '2700', brand: 'SanMar',
          variants: [
            { sourceVariantId: '2700-BLK-M', color: 'Black', size: 'M', piecePrice: 5.00 },
          ],
        },
        {
          sourceStyleId: 'PC61', styleCode: 'PC61', brand: 'Port & Company',
          variants: [
            { sourceVariantId: 'PC61-NVY-M', color: 'Navy', size: 'M', piecePrice: 4.50 },
          ],
        },
        {
          sourceStyleId: 'L500', styleCode: 'L500', brand: 'Port Authority',
          variants: [
            { sourceVariantId: 'L500-BLK-M', color: 'Black', size: 'M', piecePrice: 10.00 },
          ],
        },
        {
          sourceStyleId: 'PC54', styleCode: 'PC54', brand: 'Port & Company',
          variants: [
            { sourceVariantId: 'PC54-WHT-L', color: 'White', size: 'L', piecePrice: 3.50 },
          ],
        },
      ]);

      const result = await runDeltaIngestion({
        vendor: 'sanmar',
        target: pool,
        sourceConfig: {
          type: 'sanmar-soap-delta',
          customerNumber: 'customer',
          username: 'user',
          password: 'password',
          baseImportId,
          since: '2026-08-20T00:00:00.000Z',
        },
        fetch: deltaFetch(DISCOVERY_REMOVED, {
          '2700': {
            productResponse: PRODUCT_ERROR,
            lookupResponse: SANMAR_SOAP_NOT_FOUND_RESPONSE,
          },
        }),
        sleep: async () => {},
        batchSize: 10,
        leaseOwner: 'delta-remove-test',
      }) as DeltaResult;

      expect(result.activated).toBe(true);
      expect(result.removedStyleCount).toBe(1);
      // 5 styles minus 1 removed = 4; the 20% drop stays within the safety gate.
      expect(result.styleCount).toBe(4);
      expect(result.variantCount).toBe(4);

      // 2700 should not exist in the new import
      const removed = await pool.query(
        `SELECT id FROM catalog_styles WHERE import_id = $1 AND source_style_id = '2700'`,
        [result.importId]
      );
      expect(removed.rows).toHaveLength(0);

      // All non-removed styles should be preserved
      const preserved = await pool.query(
        `SELECT source_style_id FROM catalog_styles WHERE import_id = $1 ORDER BY source_style_id`,
        [result.importId]
      );
      expect(preserved.rows.map((r: any) => r.source_style_id)).toEqual(['K500', 'L500', 'PC54', 'PC61']);
    });

    it('no-change discovery produces a complete clone and activates', async () => {
      await resetVendor();
      const baseImportId = await seedActiveImport([
        {
          sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
          variants: [
            { sourceVariantId: '208283', color: 'Black', size: 'M', piecePrice: 11.30 },
          ],
        },
      ]);

      const result = await runDeltaIngestion({
        vendor: 'sanmar',
        target: pool,
        sourceConfig: {
          type: 'sanmar-soap-delta',
          customerNumber: 'customer',
          username: 'user',
          password: 'password',
          baseImportId,
          since: '2026-08-20T00:00:00.000Z',
        },
        fetch: deltaFetch(DISCOVERY_EMPTY, {}),
        sleep: async () => {},
        batchSize: 10,
        leaseOwner: 'delta-no-change-test',
      }) as DeltaResult;

      expect(result.activated).toBe(true);
      expect(result.modifiedStyleCount).toBe(0);
      expect(result.patchedStyleCount).toBe(0);
      expect(result.removedStyleCount).toBe(0);
      expect(result.styleCount).toBe(1);
      expect(result.variantCount).toBe(1);
    });

    it('rejects delta when base import does not match active pointer (drift)', async () => {
      await resetVendor();
      await seedActiveImport([{
        sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
        variants: [{ sourceVariantId: '208283', color: 'Black', size: 'M', piecePrice: 11.30 }],
      }]);

      await expect(runDeltaIngestion({
        vendor: 'sanmar',
        target: pool,
        sourceConfig: {
          type: 'sanmar-soap-delta',
          customerNumber: 'customer',
          username: 'user',
          password: 'password',
          baseImportId: randomUUID(), // wrong base
          since: '2026-08-20T00:00:00.000Z',
        },
        fetch: deltaFetch(DISCOVERY_EMPTY, {}),
        sleep: async () => {},
        batchSize: 10,
        leaseOwner: 'delta-drift-test',
      })).rejects.toThrow(/pointer drift|does not match/i);

      // Active pointer should be unchanged
      const pointer = await pool.query(
        `SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar'`
      );
      expect(pointer.rows).toHaveLength(1);
    });

    it('rejects delta when no active import exists', async () => {
      await resetVendor();

      await expect(runDeltaIngestion({
        vendor: 'sanmar',
        target: pool,
        sourceConfig: {
          type: 'sanmar-soap-delta',
          customerNumber: 'customer',
          username: 'user',
          password: 'password',
          baseImportId: randomUUID(),
          since: '2026-08-20T00:00:00.000Z',
        },
        fetch: deltaFetch(DISCOVERY_EMPTY, {}),
        sleep: async () => {},
        batchSize: 10,
        leaseOwner: 'delta-no-active-test',
      })).rejects.toThrow(/no active/i);
    });

    it('cleans staged data on failure and preserves active pointer', async () => {
      await resetVendor();
      const baseImportId = await seedActiveImport([{
        sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
        variants: [{ sourceVariantId: '208283', color: 'Black', size: 'M', piecePrice: 11.30 }],
      }]);

      const faultResponse = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><S:Fault><faultcode>S:Server</faultcode><faultstring>Internal failure</faultstring></S:Fault></S:Body></S:Envelope>`;

      await expect(runDeltaIngestion({
        vendor: 'sanmar',
        target: pool,
        sourceConfig: {
          type: 'sanmar-soap-delta',
          customerNumber: 'customer',
          username: 'user',
          password: 'password',
          baseImportId,
          since: '2026-08-20T00:00:00.000Z',
        },
        fetch: deltaFetch(DISCOVERY_K500, {
          K500: { productResponse: faultResponse },
        }),
        sleep: async () => {},
        batchSize: 10,
        leaseOwner: 'delta-failure-test',
      })).rejects.toThrow();

      // Active pointer unchanged
      const pointer = await pool.query(
        `SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar'`
      );
      expect(pointer.rows[0].import_id).toBe(baseImportId);

      // Staged data cleaned
      const staged = await pool.query(
        `SELECT count(*)::int AS cnt FROM catalog_styles s
         JOIN catalog_imports i ON i.id = s.import_id
         WHERE i.vendor = 'sanmar' AND i.status <> 'active'`
      );
      expect(staged.rows[0].cnt).toBe(0);

      // Job should be rejected with sanitized error
      const job = await pool.query(
        `SELECT status, error_summary FROM catalog_ingestion_jobs
         WHERE vendor = 'sanmar' ORDER BY created_at DESC LIMIT 1`
      );
      expect(job.rows[0].status).toBe('rejected');
      expect(job.rows[0].error_summary).not.toMatch(/customer|password/i);
    });

    it('rolls back and cleans the staged clone when patch insertion fails', async () => {
      await resetVendor();
      const baseImportId = await seedActiveImport([{
        sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
        variants: [{ sourceVariantId: '208283', color: 'Black', size: 'M', piecePrice: 11.30 }],
      }]);

      await expect(runDeltaIngestion({
        vendor: 'sanmar',
        target: pool,
        sourceConfig: {
          type: 'sanmar-soap-delta', customerNumber: 'customer', username: 'user',
          password: 'password', baseImportId, since: '2026-08-20T00:00:00.000Z',
        },
        fetch: deltaFetch(DISCOVERY_K500, {
          K500: { productResponse: SANMAR_SOAP_PRODUCT_RESPONSE },
        }),
        sleep: async () => {},
        leaseOwner: 'delta-patch-failure-test',
        testHooks: {
          beforeDeltaStyleInsert: async () => { throw new Error('injected patch failure'); },
        },
      })).rejects.toThrow(/injected patch failure/i);

      const pointer = await pool.query(
        `SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar'`
      );
      expect(pointer.rows[0].import_id).toBe(baseImportId);
      const staged = await pool.query(
        `SELECT count(*)::int AS cnt FROM catalog_styles s
         JOIN catalog_imports i ON i.id = s.import_id
         WHERE i.vendor = 'sanmar' AND i.status NOT IN ('active', 'superseded')`
      );
      expect(staged.rows[0].cnt).toBe(0);
    });

    it('rejects confirmed removals that exceed the final count-drop guard', async () => {
      await resetVendor();
      const baseImportId = await seedActiveImport([
        { sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority', variants: [{ sourceVariantId: 'K500-M', color: 'Black', size: 'M', piecePrice: 11.30 }] },
        { sourceStyleId: '2700', styleCode: '2700', brand: 'SanMar', variants: [{ sourceVariantId: '2700-M', color: 'Black', size: 'M', piecePrice: 5.00 }] },
        { sourceStyleId: '2701', styleCode: '2701', brand: 'SanMar', variants: [{ sourceVariantId: '2701-M', color: 'Black', size: 'M', piecePrice: 5.00 }] },
        { sourceStyleId: 'PC61', styleCode: 'PC61', brand: 'Port & Company', variants: [{ sourceVariantId: 'PC61-M', color: 'Navy', size: 'M', piecePrice: 4.50 }] },
        { sourceStyleId: 'L500', styleCode: 'L500', brand: 'Port Authority', variants: [{ sourceVariantId: 'L500-M', color: 'Black', size: 'M', piecePrice: 10.00 }] },
      ]);

      await expect(runDeltaIngestion({
        vendor: 'sanmar', target: pool,
        sourceConfig: {
          type: 'sanmar-soap-delta', customerNumber: 'customer', username: 'user',
          password: 'password', baseImportId, since: '2026-08-20T00:00:00.000Z',
        },
        fetch: deltaFetch(DISCOVERY_TWO_REMOVED, {
          '2700': { productResponse: PRODUCT_ERROR, lookupResponse: SANMAR_SOAP_NOT_FOUND_RESPONSE },
          '2701': { productResponse: PRODUCT_ERROR, lookupResponse: SANMAR_SOAP_NOT_FOUND_RESPONSE },
        }),
        sleep: async () => {}, leaseOwner: 'delta-count-drop-test',
      })).rejects.toThrow(/dropped more than 20/i);

      const pointer = await pool.query(
        `SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar'`
      );
      expect(pointer.rows[0].import_id).toBe(baseImportId);
    });

    it('cancellation preserves active pointer and cleans staged data', async () => {
      await resetVendor();
      const baseImportId = await seedActiveImport([{
        sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
        variants: [{ sourceVariantId: '208283', color: 'Black', size: 'M', piecePrice: 11.30 }],
      }]);

      const controller = new AbortController();

      // Abort during discovery
      const fetchFn = async (url: string, options: any) => {
        const parsed = new URL(url);
        if (parsed.pathname.includes('ProductDataService')) {
          controller.abort();
          throw new Error('abort');
        }
        return response(SANMAR_SOAP_PRODUCT_RESPONSE);
      };

      await expect(runDeltaIngestion({
        vendor: 'sanmar',
        target: pool,
        sourceConfig: {
          type: 'sanmar-soap-delta',
          customerNumber: 'customer',
          username: 'user',
          password: 'password',
          baseImportId,
          since: '2026-08-20T00:00:00.000Z',
        },
        fetch: fetchFn,
        sleep: async () => {},
        signal: controller.signal,
        batchSize: 10,
        leaseOwner: 'delta-cancel-test',
      })).rejects.toThrow();

      // Active pointer unchanged
      const pointer = await pool.query(
        `SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar'`
      );
      expect(pointer.rows[0].import_id).toBe(baseImportId);

      const staged = await pool.query(
        `SELECT count(*)::int AS cnt FROM catalog_styles s
         JOIN catalog_imports i ON i.id = s.import_id
         WHERE i.vendor = 'sanmar' AND i.status NOT IN ('active', 'superseded')`
      );
      expect(staged.rows[0].cnt).toBe(0);

      const canceledJob = await pool.query(
        `SELECT status FROM catalog_ingestion_jobs
         WHERE vendor = 'sanmar' ORDER BY created_at DESC LIMIT 1`
      );
      expect(canceledJob.rows[0].status).toBe('canceled');
    });

    it('categorizes cancellation requested immediately before activation', async () => {
      await resetVendor();
      const baseImportId = await seedActiveImport([{
        sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
        variants: [{ sourceVariantId: '208283', color: 'Black', size: 'M', piecePrice: 11.30 }],
      }]);

      await expect(runDeltaIngestion({
        vendor: 'sanmar', target: pool,
        sourceConfig: {
          type: 'sanmar-soap-delta', customerNumber: 'customer', username: 'user',
          password: 'password', baseImportId, since: '2026-08-20T00:00:00.000Z',
        },
        fetch: deltaFetch(DISCOVERY_EMPTY, {}), sleep: async () => {},
        leaseOwner: 'delta-pre-activation-cancel-test',
        testHooks: {
          beforeActivation: async ({ jobId }: { jobId: string }) => {
            await pool.query(
              `UPDATE catalog_ingestion_jobs SET cancel_requested = TRUE WHERE id = $1`,
              [jobId]
            );
          },
        },
      })).rejects.toThrow(/cancel/i);

      const pointer = await pool.query(
        `SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar'`
      );
      expect(pointer.rows[0].import_id).toBe(baseImportId);
      const job = await pool.query(
        `SELECT status FROM catalog_ingestion_jobs
         WHERE vendor = 'sanmar' ORDER BY created_at DESC LIMIT 1`
      );
      expect(job.rows[0].status).toBe('canceled');
      const staged = await pool.query(
        `SELECT count(*)::int AS cnt FROM catalog_styles s
         JOIN catalog_imports i ON i.id = s.import_id
         WHERE i.vendor = 'sanmar' AND i.status NOT IN ('active', 'superseded')`
      );
      expect(staged.rows[0].cnt).toBe(0);
    });

    it('activation-time pointer drift rejects when base changed during processing', async () => {
      await resetVendor();
      const baseImportId = await seedActiveImport([{
        sourceStyleId: 'K500', styleCode: 'K500', brand: 'Port Authority',
        variants: [{ sourceVariantId: '208283', color: 'Black', size: 'M', piecePrice: 11.30 }],
      }]);

      await expect(runDeltaIngestion({
        vendor: 'sanmar',
        target: pool,
        sourceConfig: {
          type: 'sanmar-soap-delta',
          customerNumber: 'customer',
          username: 'user',
          password: 'password',
          baseImportId,
          since: '2026-08-20T00:00:00.000Z',
        },
        fetch: deltaFetch(DISCOVERY_EMPTY, {}),
        sleep: async () => {},
        batchSize: 10,
        leaseOwner: 'delta-activation-drift-test',
        testHooks: {
          beforeActivation: async () => {
            // Simulate concurrent activation by changing the pointer
            const concurrentImportId = randomUUID();
            await pool.query(
              `INSERT INTO catalog_imports (id, vendor, status, source_status, source_errors,
                 style_count, variant_count, invalid_price_count, activated_at)
               VALUES ($1, 'sanmar', 'active', 'direct', 0, 1, 1, 0, CURRENT_TIMESTAMP)`,
              [concurrentImportId]
            );
            await pool.query(
              `UPDATE catalog_imports SET status = 'superseded' WHERE id = $1`,
              [baseImportId]
            );
            await pool.query(
              `UPDATE active_catalog_versions SET import_id = $1 WHERE vendor = 'sanmar'`,
              [concurrentImportId]
            );
          },
        },
      })).rejects.toThrow(/pointer drift/i);
    });
  }
);
