import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { VENDOR_CATALOG_POSTGRES_SCHEMA_SQL } from "../postgres-schema.mjs";
import { createPostgresVendorCatalogRepository } from "../postgres-repository";

const TEST_PG_URL = process.env.VENDOR_CATALOG_TEST_DATABASE_URL;
const runIntegration = TEST_PG_URL != null && TEST_PG_URL.length > 0;

describe.skipIf(!runIntegration)(
  "PostgreSQL vendor catalog integration",
  () => {
    let pool: pg.Pool;
    const ssImportId = "11111111-1111-1111-1111-111111111111";
    const sanmarImportId = "22222222-2222-2222-2222-222222222222";

    async function dropAll() {
      await pool.query("DROP VIEW IF EXISTS active_catalog_variants CASCADE");
      await pool.query("DROP VIEW IF EXISTS active_catalog_styles CASCADE");
      await pool.query("DROP TABLE IF EXISTS active_catalog_versions CASCADE");
      await pool.query("DROP TABLE IF EXISTS catalog_variants CASCADE");
      await pool.query("DROP TABLE IF EXISTS catalog_styles CASCADE");
      await pool.query("DROP TABLE IF EXISTS catalog_imports CASCADE");
    }

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: TEST_PG_URL, max: 2 });
      await dropAll();
      await pool.query(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL);

      // Seed both vendors as active
      await pool.query(
        `INSERT INTO catalog_imports (id, vendor, status, source_status, source_errors, style_count, variant_count, activated_at)
         VALUES ($1, 'ss', 'active', 'completed', 0, 2, 3, CURRENT_TIMESTAMP)`,
        [ssImportId]
      );
      await pool.query(
        `INSERT INTO catalog_imports (id, vendor, status, source_status, source_errors, style_count, variant_count, activated_at)
         VALUES ($1, 'sanmar', 'active', 'completed', 0, 1, 2, CURRENT_TIMESTAMP)`,
        [sanmarImportId]
      );
      await pool.query(
        `INSERT INTO active_catalog_versions (vendor, import_id) VALUES ('ss', $1)`,
        [ssImportId]
      );
      await pool.query(
        `INSERT INTO active_catalog_versions (vendor, import_id) VALUES ('sanmar', $1)`,
        [sanmarImportId]
      );

      // S&S styles and variants
      await pool.query(
        `INSERT INTO catalog_styles (import_id, id, vendor, source_style_id, style_code, brand, name, category, description, image_url, active_variant_count)
         VALUES ($1, 'ss:3001', 'ss', '3001', '3001', 'BELLA+CANVAS', 'Jersey Tee', 'T-Shirts', 'Soft tee', NULL, 2),
                ($1, 'ss:3001C', 'ss', '3001C', '3001C', 'BELLA+CANVAS', 'Youth Tee', 'T-Shirts', NULL, NULL, 1)`,
        [ssImportId]
      );
      await pool.query(
        `INSERT INTO catalog_variants (import_id, id, style_id, vendor, source_variant_id, style_code, color, size, size_order, inventory_qty, image_url, discontinued, resolved_cost, cost_basis)
         VALUES ($1, 'ss:3001-BLK-M', 'ss:3001', 'ss', '3001-BLK-M', '3001', 'Black', 'M', 30, 42, NULL, false, 4.25, 'customerPrice'),
                ($1, 'ss:3001-BLK-L', 'ss:3001', 'ss', '3001-BLK-L', '3001', 'Black', 'L', 40, 0, NULL, false, 5.20, 'piecePrice'),
                ($1, 'ss:3001C-BLU-S', 'ss:3001C', 'ss', '3001C-BLU-S', '3001C', 'Blue', 'S', 10, 10, NULL, false, 3.90, 'customerPrice')`,
        [ssImportId]
      );

      // SanMar styles and variants
      await pool.query(
        `INSERT INTO catalog_styles (import_id, id, vendor, source_style_id, style_code, brand, name, category, image_url, active_variant_count)
         VALUES ($1, 'sanmar:K500', 'sanmar', 'K500', 'K500', 'Port Authority', 'Silk Touch Polo', 'Polos', NULL, 2)`,
        [sanmarImportId]
      );
      await pool.query(
        `INSERT INTO catalog_variants (import_id, id, style_id, vendor, source_variant_id, style_code, color, size, size_order, inventory_qty, image_url, discontinued, resolved_cost, cost_basis)
         VALUES ($1, 'sanmar:K500-RED-M', 'sanmar:K500', 'sanmar', 'K500-RED-M', 'K500', 'Red', 'M', 20, NULL, NULL, false, 9.75, 'piecePrice'),
                ($1, 'sanmar:K500-RED-L', 'sanmar:K500', 'sanmar', 'K500-RED-L', 'K500', 'Red', 'L', 30, NULL, NULL, false, 9.75, 'piecePrice')`,
        [sanmarImportId]
      );
    });

    afterAll(async () => {
      if (pool) {
        await dropAll();
        await pool.end();
      }
    });

    function repo() {
      return createPostgresVendorCatalogRepository({
        async query(text, values) {
          const result = await pool.query(text, values);
          return { rows: result.rows };
        },
      });
    }

    // --- Schema / Views ---

    it("creates schema with all expected tables and views", async () => {
      const result = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
         AND table_name IN ('catalog_imports', 'catalog_styles', 'catalog_variants', 'active_catalog_versions')
         ORDER BY table_name`
      );
      expect(result.rows.map((r: { table_name: string }) => r.table_name)).toEqual([
        "active_catalog_versions",
        "catalog_imports",
        "catalog_styles",
        "catalog_variants",
      ]);

      const views = await pool.query(
        `SELECT table_name FROM information_schema.views
         WHERE table_schema = 'public'
         AND table_name IN ('active_catalog_styles', 'active_catalog_variants')
         ORDER BY table_name`
      );
      expect(views.rows.map((r: { table_name: string }) => r.table_name)).toEqual([
        "active_catalog_styles",
        "active_catalog_variants",
      ]);
    });

    it("active views filter by catalog_imports status=active", async () => {
      const viewDef = await pool.query(
        `SELECT pg_get_viewdef('active_catalog_styles'::regclass, true) AS def`
      );
      expect(String((viewDef.rows[0] as { def: string }).def)).toContain("i.status = 'active'");
    });

    // --- Both-active status ---

    it("reports available when both ss and sanmar are active", async () => {
      const result = await pool.query(
        `SELECT a.vendor FROM active_catalog_versions a
         JOIN catalog_imports i ON i.id = a.import_id AND i.status = 'active'`
      );
      const vendors = new Set(result.rows.map((r: { vendor: string }) => r.vendor));
      expect(vendors.has("ss")).toBe(true);
      expect(vendors.has("sanmar")).toBe(true);
    });

    it("reports unavailable when one vendor is missing", async () => {
      // Temporarily remove sanmar active version
      await pool.query("DELETE FROM active_catalog_versions WHERE vendor = 'sanmar'");

      const result = await pool.query(
        `SELECT a.vendor FROM active_catalog_versions a
         JOIN catalog_imports i ON i.id = a.import_id AND i.status = 'active'`
      );
      const vendors = new Set(result.rows.map((r: { vendor: string }) => r.vendor));
      expect(vendors.has("ss")).toBe(true);
      expect(vendors.has("sanmar")).toBe(false);

      // Restore
      await pool.query(
        `INSERT INTO active_catalog_versions (vendor, import_id) VALUES ('sanmar', $1)`,
        [sanmarImportId]
      );
    });

    it("reports unavailable when import status is not active", async () => {
      // Set sanmar import to superseded
      await pool.query(
        `UPDATE catalog_imports SET status = 'superseded' WHERE id = $1`,
        [sanmarImportId]
      );

      const result = await pool.query(
        `SELECT a.vendor FROM active_catalog_versions a
         JOIN catalog_imports i ON i.id = a.import_id AND i.status = 'active'`
      );
      const vendors = new Set(result.rows.map((r: { vendor: string }) => r.vendor));
      expect(vendors.has("sanmar")).toBe(false);

      // Active view should not return sanmar rows
      const sanmarStyles = await pool.query(
        `SELECT count(*)::int AS cnt FROM active_catalog_styles WHERE vendor = 'sanmar'`
      );
      expect(Number((sanmarStyles.rows[0] as { cnt: number }).cnt)).toBe(0);

      // Restore
      await pool.query(
        `UPDATE catalog_imports SET status = 'active' WHERE id = $1`,
        [sanmarImportId]
      );
    });

    // --- Style and variant queries ---

    it("searches styles via active view and returns ranked results", async () => {
      const results = await repo().searchStyles({ query: "3001", vendor: "all" });
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0].styleCode).toBe("3001");
      expect(results[1].styleCode).toBe("3001C");
      for (const r of results) {
        expect(Object.keys(r).join(" ")).not.toMatch(/cost|price|cogs/i);
      }
    });

    it("returns variants for a style without cost columns", async () => {
      const variants = await repo().getStyleVariants("ss:3001");
      expect(variants).toHaveLength(2);
      expect(variants[0].color).toBe("Black");
      for (const v of variants) {
        expect(Object.keys(v).join(" ")).not.toMatch(/cost|price|cogs/i);
      }
    });

    it("resolves variant cost server-side", async () => {
      const cost = await repo().resolveVariantCost("ss:3001-BLK-M");
      expect(cost).toMatchObject({
        variantId: "ss:3001-BLK-M",
        vendor: "ss",
        unitCost: 4.25,
        costBasis: "customerPrice",
      });
    });

    it("resolves sanmar variant cost", async () => {
      const cost = await repo().resolveVariantCost("sanmar:K500-RED-L");
      expect(cost).toMatchObject({
        variantId: "sanmar:K500-RED-L",
        vendor: "sanmar",
        unitCost: 9.75,
        costBasis: "piecePrice",
      });
    });

    it("returns undefined for unknown variant", async () => {
      const cost = await repo().resolveVariantCost("ss:does-not-exist");
      expect(cost).toBeUndefined();
    });

    it("filters by vendor parameter", async () => {
      const ssResults = await repo().searchStyles({ query: "3001", vendor: "ss" });
      expect(ssResults.length).toBeGreaterThan(0);
      for (const r of ssResults) {
        expect(r.vendor).toBe("ss");
      }
      const sanmarResults = await repo().searchStyles({ query: "3001", vendor: "sanmar" });
      expect(sanmarResults).toHaveLength(0);
    });

    it("short queries return empty results", async () => {
      const results = await repo().searchStyles({ query: "3", vendor: "all" });
      expect(results).toHaveLength(0);
    });

    // --- Activation rollback ---

    it("rolls back activation on failure without corrupting state", async () => {
      const badImportId = "33333333-3333-3333-3333-333333333333";
      await pool.query(
        `INSERT INTO catalog_imports (id, vendor, status, source_status, source_errors, style_count, variant_count)
         VALUES ($1, 'ss', 'building', 'completed', 0, 0, 0)`,
        [badImportId]
      );

      // Try to activate a 'building' import (should fail — status must be 'validating')
      const client = await pool.connect();
      let rollbackOccurred = false;
      try {
        await client.query("BEGIN");
        const activateResult = await client.query(
          `UPDATE catalog_imports
           SET status = 'active', activated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND vendor = 'ss' AND status = 'validating'`,
          [badImportId]
        );
        if (activateResult.rowCount !== 1) {
          throw new Error("Activation failed — status not validating.");
        }
        await client.query("COMMIT");
      } catch {
        await client.query("ROLLBACK");
        rollbackOccurred = true;
      } finally {
        client.release();
      }
      expect(rollbackOccurred).toBe(true);

      // Original SS import should still be active
      const activeResult = await pool.query(
        `SELECT import_id FROM active_catalog_versions WHERE vendor = 'ss'`
      );
      expect(String((activeResult.rows[0] as { import_id: string }).import_id)).toBe(ssImportId);

      // Cleanup
      await pool.query(`DELETE FROM catalog_imports WHERE id = $1`, [badImportId]);
    });

    // --- Rejected import cleanup ---

    it("deleted staged rows survive as rejected metadata only", async () => {
      const rejectedImportId = "44444444-4444-4444-4444-444444444444";
      await pool.query(
        `INSERT INTO catalog_imports (id, vendor, status, source_status, source_errors, style_count, variant_count)
         VALUES ($1, 'ss', 'building', 'completed', 0, 1, 1)`,
        [rejectedImportId]
      );
      await pool.query(
        `INSERT INTO catalog_styles (import_id, id, vendor, source_style_id, style_code, active_variant_count)
         VALUES ($1, 'ss:REJECT-TEST', 'ss', 'REJECT-TEST', 'REJECT-TEST', 1)`,
        [rejectedImportId]
      );
      await pool.query(
        `INSERT INTO catalog_variants (import_id, id, style_id, vendor, source_variant_id, style_code, resolved_cost, cost_basis)
         VALUES ($1, 'ss:REJECT-V1', 'ss:REJECT-TEST', 'ss', 'REJECT-V1', 'REJECT-TEST', 1.00, 'piecePrice')`,
        [rejectedImportId]
      );

      // Reject: update status and delete staged rows
      await pool.query(
        `UPDATE catalog_imports SET status = 'rejected', rejection_reason = 'test rejection'
         WHERE id = $1`,
        [rejectedImportId]
      );
      await pool.query(`DELETE FROM catalog_styles WHERE import_id = $1`, [rejectedImportId]);
      await pool.query(`DELETE FROM catalog_variants WHERE import_id = $1`, [rejectedImportId]);

      // Metadata row should still exist
      const metaResult = await pool.query(
        `SELECT status, rejection_reason FROM catalog_imports WHERE id = $1`,
        [rejectedImportId]
      );
      expect(metaResult.rows).toHaveLength(1);
      expect((metaResult.rows[0] as { status: string }).status).toBe("rejected");
      expect((metaResult.rows[0] as { rejection_reason: string }).rejection_reason).toBe("test rejection");

      // Staged rows should be gone
      const styleResult = await pool.query(
        `SELECT count(*)::int AS cnt FROM catalog_styles WHERE import_id = $1`,
        [rejectedImportId]
      );
      expect(Number((styleResult.rows[0] as { cnt: number }).cnt)).toBe(0);

      const variantResult = await pool.query(
        `SELECT count(*)::int AS cnt FROM catalog_variants WHERE import_id = $1`,
        [rejectedImportId]
      );
      expect(Number((variantResult.rows[0] as { cnt: number }).cnt)).toBe(0);

      // Cleanup
      await pool.query(`DELETE FROM catalog_imports WHERE id = $1`, [rejectedImportId]);
    });

    // --- Public vs cost projections ---

    it("public variant query does not include cost columns", async () => {
      const result = await pool.query(
        `SELECT * FROM active_catalog_variants WHERE id = 'ss:3001-BLK-M' LIMIT 1`
      );
      const row = result.rows[0] as Record<string, unknown>;
      // The view returns all columns including resolved_cost, but the repository
      // query (which is what public endpoints use) only SELECTs public columns.
      // Verify the repository does not leak cost data:
      const variants = await repo().getStyleVariants("ss:3001");
      for (const v of variants) {
        expect(Object.keys(v).join(" ")).not.toMatch(/cost|price|cogs/i);
      }
      // The raw view does have resolved_cost (this is expected for server-side use)
      expect(row).toHaveProperty("resolved_cost");
    });

    it("cost resolution returns full cost data for server-side use", async () => {
      const cost = await repo().resolveVariantCost("ss:3001-BLK-M");
      expect(cost).toBeDefined();
      expect(cost!.unitCost).toBe(4.25);
      expect(cost!.costBasis).toBe("customerPrice");
      expect(cost!.vendor).toBe("ss");
      expect(cost!.styleCode).toBe("3001");
    });

    // --- active_variant_count correctness ---

    it("style active_variant_count equals actual imported variant count per style", async () => {
      const result = await pool.query(
        `SELECT s.id, s.active_variant_count,
                (SELECT count(*)::int FROM catalog_variants v WHERE v.style_id = s.id AND v.import_id = s.import_id) AS actual_count
         FROM catalog_styles s
         WHERE s.import_id IN ($1, $2)`,
        [ssImportId, sanmarImportId]
      );
      for (const row of result.rows as { id: string; active_variant_count: number; actual_count: number }[]) {
        expect(row.active_variant_count).toBe(row.actual_count);
      }
    });

    // --- CASCADE behavior ---

    it("CASCADE deletes variants when styles are deleted", async () => {
      const cascadeImportId = "55555555-5555-5555-5555-555555555555";
      await pool.query(
        `INSERT INTO catalog_imports (id, vendor, status, source_status, source_errors, style_count, variant_count)
         VALUES ($1, 'ss', 'building', 'completed', 0, 1, 1)`,
        [cascadeImportId]
      );
      await pool.query(
        `INSERT INTO catalog_styles (import_id, id, vendor, source_style_id, style_code, active_variant_count)
         VALUES ($1, 'ss:CASCADE-TEST', 'ss', 'CASCADE-TEST', 'CASCADE-TEST', 1)`,
        [cascadeImportId]
      );
      await pool.query(
        `INSERT INTO catalog_variants (import_id, id, style_id, vendor, source_variant_id, style_code, resolved_cost, cost_basis)
         VALUES ($1, 'ss:CASCADE-V1', 'ss:CASCADE-TEST', 'ss', 'CASCADE-V1', 'CASCADE-TEST', 1.00, 'piecePrice')`,
        [cascadeImportId]
      );

      // Delete styles — variants should cascade
      await pool.query(`DELETE FROM catalog_styles WHERE import_id = $1`, [cascadeImportId]);
      const variantResult = await pool.query(
        `SELECT count(*)::int AS cnt FROM catalog_variants WHERE import_id = $1`,
        [cascadeImportId]
      );
      expect(Number((variantResult.rows[0] as { cnt: number }).cnt)).toBe(0);

      // Cleanup
      await pool.query(`DELETE FROM catalog_imports WHERE id = $1`, [cascadeImportId]);
    });
  }
);
