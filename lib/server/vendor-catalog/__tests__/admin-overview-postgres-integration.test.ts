import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { VENDOR_CATALOG_POSTGRES_SCHEMA_SQL } from "../postgres-schema.mjs";
import { queryAdminCatalogOverview } from "../admin-overview";

const TEST_PG_URL = process.env.VENDOR_CATALOG_TEST_DATABASE_URL;
const runIntegration = TEST_PG_URL != null && TEST_PG_URL.length > 0;

const SCHEMA_NAME = `test_admin_overview_${process.pid}_${randomUUID().replaceAll("-", "_")}`;

describe.skipIf(!runIntegration)("admin catalog overview PostgreSQL integration", () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;

  const ssImportId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const ssPreviousImportId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const sanmarImportId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const seededSecret = "seeded-secret-must-not-appear";

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: TEST_PG_URL, max: 1 });
    await adminPool.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
    pool = new pg.Pool({
      connectionString: TEST_PG_URL,
      max: 2,
      options: `-c search_path=${SCHEMA_NAME}`,
    });
    await pool.query(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL);

    await pool.query(
      `INSERT INTO catalog_imports
         (id, vendor, status, source_status, source_errors, style_count, variant_count,
          source_sync_at, imported_at, activated_at, source_metadata)
       VALUES
         ($1, 'ss', 'active', 'completed', 0, 1, 2,
          '2026-08-20T10:00:00Z', '2026-08-20T10:05:00Z', '2026-08-20T10:10:00Z',
          jsonb_build_object('secret', $4::text)),
         ($2, 'ss', 'superseded', 'completed', 0, 0, 0,
          '2026-08-19T10:00:00Z', '2026-08-19T10:05:00Z', NULL, '{}'::jsonb),
         ($3, 'sanmar', 'active', 'completed', 0, 1, 2,
          '2026-08-21T10:00:00Z', '2026-08-21T10:05:00Z', '2026-08-21T10:10:00Z',
          '{}'::jsonb)`,
      [ssImportId, ssPreviousImportId, sanmarImportId, seededSecret]
    );
    await pool.query(
      `INSERT INTO active_catalog_versions (vendor, import_id)
       VALUES ('ss', $1), ('sanmar', $2)`,
      [ssImportId, sanmarImportId]
    );

    await pool.query(
      `INSERT INTO catalog_styles
         (import_id, id, vendor, source_style_id, style_code, active_variant_count)
       VALUES
         ($1, 'ss:3001', 'ss', '3001', '3001', 2),
         ($2, 'sanmar:K500', 'sanmar', 'K500', 'K500', 2)`,
      [ssImportId, sanmarImportId]
    );
    await pool.query(
      `INSERT INTO catalog_variants
         (import_id, id, style_id, vendor, source_variant_id, style_code,
          piece_price, resolved_cost, cost_basis)
       VALUES
         ($1, 'ss:3001-BLK-M', 'ss:3001', 'ss', '3001-BLK-M', '3001', 5.00, 5.00, 'piecePrice'),
         ($1, 'ss:3001-BLK-L', 'ss:3001', 'ss', '3001-BLK-L', '3001', 5.20, 5.20, 'piecePrice')`,
      [ssImportId]
    );
    await pool.query(
      `INSERT INTO catalog_variants
         (import_id, id, style_id, vendor, source_variant_id, style_code,
          case_price, resolved_cost, cost_basis)
       VALUES
         ($1, 'sanmar:K500-RED-M', 'sanmar:K500', 'sanmar', 'K500-RED-M', 'K500', 9.25, 9.25, 'casePrice'),
         ($1, 'sanmar:K500-RED-L', 'sanmar:K500', 'sanmar', 'K500-RED-L', 'K500', 9.25, 9.25, 'casePrice')`,
      [sanmarImportId]
    );

    for (let n = 1; n <= 12; n += 1) {
      await pool.query(
        `INSERT INTO catalog_ingestion_jobs
           (id, vendor, status, lease_owner, checkpoint, attempts, error_summary,
            import_id, created_at, started_at, completed_at)
         VALUES (
           $1,
           $2,
           $3,
           $4,
           jsonb_build_object('phase', $5::text, 'secret', $4::text),
           $6,
           $4,
           $7,
           $8,
           '2026-08-22T10:00:00Z'::timestamptz,
           $9
         )`,
        [
          randomUUID(),
          n % 2 === 0 ? "ss" : "sanmar",
          n === 12 ? "running" : "completed",
          seededSecret,
          n === 11 ? "private-phase" : "validating",
          n,
          n % 2 === 0 ? ssImportId : sanmarImportId,
          new Date(Date.parse("2026-08-22T10:00:00Z") + n * 60_000),
          n === 12 ? null : "2026-08-22T10:05:00Z",
        ]
      );
    }

    await pool.query(
      `INSERT INTO catalog_rollbacks
         (id, vendor, from_import_id, to_import_id, requested_by, reason)
       VALUES
         ($1, 'ss', $3, $4, $5, $5),
         ($2, 'ss', $3, $4, $5, $5)`,
      [randomUUID(), randomUUID(), ssImportId, ssPreviousImportId, seededSecret]
    );
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
      await adminPool.end();
    }
  });

  it("returns safe active summaries, canary counts, bounded jobs, and rollback aggregates", async () => {
    const overview = await queryAdminCatalogOverview({
      async query(text, values) {
        const result = await pool.query(text, values);
        return { rows: result.rows };
      },
    });

    expect(overview.vendors.ss).toMatchObject({
      active: true,
      activeImportStatus: "active",
      styleCount: 1,
      variantCount: 2,
      canaryStyleCode: "3001",
      canaryStyleRows: 1,
      canaryVariantRows: 2,
      activeJobStatus: "running",
      health: "warning",
    });
    expect(overview.vendors.sanmar).toMatchObject({
      active: true,
      activeImportStatus: "active",
      canaryStyleCode: "K500",
      canaryStyleRows: 1,
      canaryVariantRows: 2,
    });
    expect(overview.recentJobs).toHaveLength(8);
    expect(overview.recentJobs[0]).toMatchObject({
      vendor: "ss",
      status: "running",
      phase: "validating",
    });
    expect(
      overview.recentJobs.some(
        (job) => (job.phase as string | null) === "private-phase"
      )
    ).toBe(false);
    expect(overview.rollbackSummary.ss.totalCount).toBeGreaterThanOrEqual(2);
    expect(overview.rollbackSummary.ss.latestAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const serialized = JSON.stringify(overview);
    expect(serialized).not.toMatch(
      /resolved_cost|cost_basis|source_metadata|error_summary|requested_by|reason|lease_owner|checkpoint|import_id|job_id|audit_id|catalog_imports|catalog_ingestion_jobs|catalog_rollbacks/i
    );
    expect(serialized).not.toContain(seededSecret);
    expect(serialized).not.toContain(ssImportId);
    expect(serialized).not.toContain(ssPreviousImportId);
    expect(serialized).not.toContain(sanmarImportId);
  });
});
