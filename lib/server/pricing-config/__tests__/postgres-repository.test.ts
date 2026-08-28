import { describe, expect, it, vi } from "vitest";
import { createPostgresPricingConfigRepository } from "../postgres-repository";

/**
 * Fake pg Pool whose single client resolves each `query()` call from a
 * pre-queued list of responses, in the exact order the repository issues
 * them (BEGIN, advisory lock, SELECT ... FOR UPDATE, INSERT/UPDATE, COMMIT).
 */
function fakePool(responses: Array<{ rows: unknown[] }>) {
  const queue = [...responses];
  const query = vi.fn(async (_sql: unknown, _params?: unknown) =>
    Promise.resolve(queue.shift() ?? { rows: [] })
  );
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release });
  return { pool: { connect } as never, query, release };
}

function versionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    config_type: "dtf_matrix",
    data: { lanes: [], tiers: [] },
    status: "active",
    created_by: "admin@cmpsportswear.com",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    activated_at: new Date("2026-01-01T00:00:00.000Z"),
    superseded_at: null,
    ...overrides,
  };
}

describe("PostgreSQL pricing config repository", () => {
  describe("saveAndActivate", () => {
    it("returns a conflict when the current active version does not match expectedVersionId", async () => {
      const { pool, query, release } = fakePool([
        { rows: [] }, // BEGIN
        { rows: [] }, // advisory lock
        { rows: [{ version_id: "existing-version-id" }] }, // current active FOR UPDATE
        { rows: [] }, // COMMIT
      ]);
      const repo = createPostgresPricingConfigRepository(pool);

      const result = await repo.saveAndActivate(
        "dtf_matrix",
        { lanes: [], tiers: [] } as never,
        "admin@cmpsportswear.com",
        null
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("conflict");
        expect(result.message).toContain("existing-version-id");
      }
      // Only BEGIN, advisory lock, current-active check, COMMIT — no writes attempted.
      expect(query).toHaveBeenCalledTimes(4);
      expect(release).toHaveBeenCalledOnce();
    });

    it("creates the first active version when none exists yet", async () => {
      const newRow = versionRow({ id: "22222222-2222-2222-2222-222222222222" });
      const { pool, query } = fakePool([
        { rows: [] }, // BEGIN
        { rows: [] }, // advisory lock
        { rows: [] }, // current active FOR UPDATE (none yet)
        { rows: [newRow] }, // INSERT new version RETURNING *
        { rows: [] }, // upsert active pointer
        { rows: [] }, // audit event
        { rows: [] }, // COMMIT
      ]);
      const repo = createPostgresPricingConfigRepository(pool);

      const result = await repo.saveAndActivate(
        "dtf_matrix",
        { lanes: [], tiers: [] } as never,
        "admin@cmpsportswear.com",
        null
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.version.id).toBe("22222222-2222-2222-2222-222222222222");
        expect(result.version.status).toBe("active");
      }
      const supersedeCall = query.mock.calls.find(([sql]) =>
        String(sql).includes("SET status = 'superseded'")
      );
      expect(supersedeCall).toBeUndefined();
    });

    it("supersedes the prior active version when replacing it", async () => {
      const newRow = versionRow({ id: "33333333-3333-3333-3333-333333333333" });
      const { pool, query } = fakePool([
        { rows: [] }, // BEGIN
        { rows: [] }, // advisory lock
        { rows: [{ version_id: "prior-id" }] }, // current active FOR UPDATE
        { rows: [] }, // UPDATE supersede
        { rows: [newRow] }, // INSERT new version RETURNING *
        { rows: [] }, // upsert active pointer
        { rows: [] }, // audit event
        { rows: [] }, // COMMIT
      ]);
      const repo = createPostgresPricingConfigRepository(pool);

      const result = await repo.saveAndActivate(
        "dtf_matrix",
        { lanes: [], tiers: [] } as never,
        "admin@cmpsportswear.com",
        "prior-id"
      );

      expect(result.ok).toBe(true);
      const supersedeCall = query.mock.calls.find(([sql]) =>
        String(sql).includes("SET status = 'superseded'")
      );
      expect(supersedeCall).toBeDefined();
      expect(supersedeCall?.[1]).toEqual(["prior-id"]);
    });
  });

  describe("activateVersion (rollback)", () => {
    it("returns not_found when the target version does not exist", async () => {
      const { pool } = fakePool([
        { rows: [] }, // BEGIN
        { rows: [] }, // advisory lock
        { rows: [] }, // target version lookup — none found
        { rows: [] }, // COMMIT
      ]);
      const repo = createPostgresPricingConfigRepository(pool);

      const result = await repo.activateVersion(
        "dtf_matrix",
        "missing-id",
        null,
        "admin@cmpsportswear.com"
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("not_found");
    });

    it("returns already_active when the target version is already active", async () => {
      const { pool } = fakePool([
        { rows: [] }, // BEGIN
        { rows: [] }, // advisory lock
        { rows: [versionRow({ status: "active" })] }, // target lookup
        { rows: [] }, // COMMIT
      ]);
      const repo = createPostgresPricingConfigRepository(pool);

      const result = await repo.activateVersion(
        "dtf_matrix",
        versionRow().id as string,
        null,
        "admin@cmpsportswear.com"
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("already_active");
    });

    it("returns a conflict when the current active version does not match expectedCurrentVersionId", async () => {
      const { pool } = fakePool([
        { rows: [] }, // BEGIN
        { rows: [] }, // advisory lock
        { rows: [versionRow({ status: "superseded" })] }, // target lookup
        { rows: [{ version_id: "someone-elses-version" }] }, // current active FOR UPDATE
        { rows: [] }, // COMMIT
      ]);
      const repo = createPostgresPricingConfigRepository(pool);

      const result = await repo.activateVersion(
        "dtf_matrix",
        versionRow().id as string,
        "stale-expected-id",
        "admin@cmpsportswear.com"
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("conflict");
    });

    it("creates a NEW immutable version copied from the historical target on rollback", async () => {
      const targetData = {
        lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
        tiers: [{ tier: "1+", minQty: 1, maxQty: null, prices: { T1: 5 } }],
      };
      const target = versionRow({
        id: "old-superseded-id",
        status: "superseded",
        data: targetData,
      });
      const copy = versionRow({ id: "brand-new-copy-id", data: targetData });
      const { pool, query } = fakePool([
        { rows: [] }, // BEGIN
        { rows: [] }, // advisory lock
        { rows: [target] }, // target lookup
        { rows: [{ version_id: "current-active-id" }] }, // current active FOR UPDATE
        { rows: [] }, // UPDATE supersede current
        { rows: [copy] }, // INSERT new copy RETURNING *
        { rows: [] }, // upsert active pointer
        { rows: [] }, // audit event (rollback)
        { rows: [] }, // COMMIT
      ]);
      const repo = createPostgresPricingConfigRepository(pool);

      const result = await repo.activateVersion(
        "dtf_matrix",
        "old-superseded-id",
        "current-active-id",
        "admin@cmpsportswear.com"
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        // The new active version has a fresh id — it is a copy, not the original row reactivated.
        expect(result.version.id).toBe("brand-new-copy-id");
        expect(result.version.id).not.toBe("old-superseded-id");
        expect(result.version.data).toEqual(targetData);
      }

      const insertCopyCall = query.mock.calls.find(
        ([sql]) =>
          String(sql).includes("INSERT INTO pricing_config_versions") &&
          !String(sql).includes("UPDATE")
      );
      expect(insertCopyCall?.[1]).toEqual([
        "dtf_matrix",
        JSON.stringify(targetData),
        "admin@cmpsportswear.com",
      ]);

      const auditCall = query.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO pricing_config_events")
      );
      // Three distinct version ids: the requested historical source, the
      // version it superseded, and the freshly created copy.
      expect(auditCall?.[1]).toEqual([
        "dtf_matrix",
        "admin@cmpsportswear.com",
        "current-active-id",
        "brand-new-copy-id",
        "old-superseded-id",
      ]);
    });

    it("copies the parsed/defaulted data on rollback, not the raw stored JSON (operatorOperatingCost default survives)", async () => {
      const legacyServiceMissingOperatingCost = {
        key: "legacy_service",
        name: "Legacy Service",
        description: "Saved before operatorOperatingCost existed",
        type: "service",
        geometryKey: "FLAT_LARGE",
        composition: [{ sizeKey: "FLAT_LARGE", quantityPerShirt: 1 }],
        cogs: 2,
        // operatorOperatingCost intentionally omitted from the stored row
        enginePrice: 5,
        policyFloor: 0,
        manualOverride: null,
        effectivePrice: 5,
        grossMargin: 0.5,
        status: "Engine price",
        operatorMinPerShirt: 0,
        designerMinPerOrder: 0,
        active: true,
        sortOrder: 0,
      };
      const legacyData = {
        services: [legacyServiceMissingOperatingCost],
        columns: [
          { key: "name", label: "Service", required: true, visible: true, order: 0 },
          { key: "effectivePrice", label: "Price", required: true, visible: true, order: 1 },
        ],
        minimumBillableQuantity: 12,
      };
      const target = versionRow({
        id: "old-superseded-id",
        config_type: "additional_prints",
        status: "superseded",
        data: legacyData,
      });
      const copy = versionRow({ id: "brand-new-copy-id", config_type: "additional_prints" });
      const { pool, query } = fakePool([
        { rows: [] }, // BEGIN
        { rows: [] }, // advisory lock
        { rows: [target] }, // target lookup
        { rows: [{ version_id: "current-active-id" }] }, // current active FOR UPDATE
        { rows: [] }, // UPDATE supersede current
        { rows: [copy] }, // INSERT new copy RETURNING *
        { rows: [] }, // upsert active pointer
        { rows: [] }, // audit event (rollback)
        { rows: [] }, // COMMIT
      ]);
      const repo = createPostgresPricingConfigRepository(pool);

      const result = await repo.activateVersion(
        "additional_prints",
        "old-superseded-id",
        "current-active-id",
        "admin@cmpsportswear.com"
      );

      expect(result.ok).toBe(true);

      const insertCopyCall = query.mock.calls.find(
        ([sql]) =>
          String(sql).includes("INSERT INTO pricing_config_versions") &&
          !String(sql).includes("UPDATE")
      );
      const insertParams = insertCopyCall?.[1] as unknown[] | undefined;
      const insertedData = JSON.parse(insertParams?.[1] as string);
      // The raw stored row has no operatorOperatingCost key at all; the copy
      // written on rollback must carry the schema-applied default (0), proving
      // the insert used the parsed result.data, not the raw JSONB.
      expect(legacyServiceMissingOperatingCost).not.toHaveProperty("operatorOperatingCost");
      expect(insertedData.services[0].operatorOperatingCost).toBe(0);
    });

    it("rejects rollback when the historical target no longer conforms to the current schema", async () => {
      const target = versionRow({
        id: "old-superseded-id",
        status: "superseded",
        data: { lanes: [], tiers: [] }, // invalid: needs >=1 lane and >=1 tier
      });
      const { pool, query } = fakePool([
        { rows: [] }, // BEGIN
        { rows: [] }, // advisory lock
        { rows: [target] }, // target lookup
        { rows: [{ version_id: "current-active-id" }] }, // current active FOR UPDATE
        { rows: [] }, // COMMIT
      ]);
      const repo = createPostgresPricingConfigRepository(pool);

      const result = await repo.activateVersion(
        "dtf_matrix",
        "old-superseded-id",
        "current-active-id",
        "admin@cmpsportswear.com"
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid_snapshot");
        expect(result.message).toContain("current dtf_matrix schema");
      }
      // No supersede, insert copy, or audit event — validation short-circuits before any mutation.
      const supersedeCall = query.mock.calls.find(([sql]) =>
        String(sql).includes("SET status = 'superseded'")
      );
      const insertCopyCall = query.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO pricing_config_versions")
      );
      expect(supersedeCall).toBeUndefined();
      expect(insertCopyCall).toBeUndefined();
    });
  });
});
