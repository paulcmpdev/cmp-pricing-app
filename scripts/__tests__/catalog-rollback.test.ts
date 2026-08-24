import { describe, expect, it, vi } from "vitest";
import {
  assertRollbackStateSafe,
  executeCatalogRollback,
  inspectRollbackState,
  parseRollbackArgs,
} from "../lib/catalog-rollback.mjs";

const CURRENT_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_URL = "postgres://rollback_user:top-secret@db.internal/catalog";

type RollbackState = {
  vendor: string;
  expectedCurrentImportId: string;
  targetImportId: string;
  live: { importId: string | null; status: string | null };
  target: {
    exists: boolean;
    vendor: string | null;
    status: string | null;
    actualStyleCount: number;
    actualVariantCount: number;
    storedStyleCount: number | null;
    storedVariantCount: number | null;
    orphanVariantCount: number;
    invalidResolvedCostCount: number;
    ssBasisViolationCount: number;
    nullStyleSourceSyncAtCount: number;
    nullVariantSourceSyncAtCount: number;
    knownStylePresent: boolean;
    sourceSyncAt: unknown;
    activatedAt: unknown;
    importedAt: unknown;
  };
  nonTerminalJobs: { count: number; statuses: Array<{ status: string; count: number }> };
};

function validArgv(overrides: Record<string, string> = {}) {
  const values = {
    "--vendor": "sanmar",
    "--expected-current-import-id": CURRENT_ID,
    "--to-import-id": TARGET_ID,
    "--requested-by": "Operator",
    "--reason": "Restore known-good catalog",
    "--target-url": TARGET_URL,
    ...overrides,
  };
  return Object.entries(values).flat();
}

function safeState(
  overrides: Record<string, unknown> = {}
): any {
  return {
    vendor: "sanmar",
    expectedCurrentImportId: CURRENT_ID,
    targetImportId: TARGET_ID,
    live: { importId: CURRENT_ID, status: "active" },
    target: {
      exists: true,
      vendor: "sanmar",
      status: "superseded",
      actualStyleCount: 20,
      actualVariantCount: 100,
      storedStyleCount: 20,
      storedVariantCount: 100,
      orphanVariantCount: 0,
      invalidResolvedCostCount: 0,
      ssBasisViolationCount: 0,
      sanmarCasePriceInvariantViolationCount: 0,
      nullStyleSourceSyncAtCount: 0,
      nullVariantSourceSyncAtCount: 0,
      knownStylePresent: true,
      sourceSyncAt: "2026-08-01T12:00:00.000Z",
      activatedAt: "2026-08-01T12:05:00.000Z",
      importedAt: "2026-08-01T11:55:00.000Z",
    },
    nonTerminalJobs: { count: 0, statuses: [] },
    ...overrides,
  };
}

describe("parseRollbackArgs", () => {
  it("strictly parses, normalizes, and keeps the target URL out of serialization", () => {
    const parsed = parseRollbackArgs(
      validArgv({
        "--requested-by": "  Ｐａｕｌ\u00a0",
        "--reason": "\u2003Rollback　after validation\u2002",
      }),
      {}
    );

    expect(parsed).toMatchObject({
      vendor: "sanmar",
      expectedCurrentImportId: CURRENT_ID,
      toImportId: TARGET_ID,
      requestedBy: "Paul",
      reason: "Rollback after validation",
    });
    expect(parsed.targetUrl).toBe(TARGET_URL);
    expect(JSON.stringify(parsed)).not.toContain(TARGET_URL);
    expect(Object.keys(parsed)).not.toContain("targetUrl");
  });

  it("accepts the target URL from the environment without serializing it", () => {
    const argv = validArgv();
    argv.splice(argv.indexOf("--target-url"), 2);
    const parsed = parseRollbackArgs(argv, {
      VENDOR_CATALOG_DATABASE_URL: TARGET_URL,
    });
    expect(parsed.targetUrl).toBe(TARGET_URL);
    expect(JSON.stringify(parsed)).not.toContain("top-secret");
  });

  it("parses a valid SS rollback request", () => {
    expect(parseRollbackArgs(validArgv({ "--vendor": "ss" }), {})).toMatchObject({
      vendor: "ss",
      expectedCurrentImportId: CURRENT_ID,
      toImportId: TARGET_ID,
      requestedBy: "Operator",
      reason: "Restore known-good catalog",
    });
  });

  it.each(["postgres://db.internal/catalog", "postgresql://db.internal/catalog"])(
    "accepts and trims a valid %s target URL",
    (targetUrl) => {
      const parsed = parseRollbackArgs(
        validArgv({
          "--vendor": "  ｓｓ  ",
          "--expected-current-import-id": `  ${CURRENT_ID.toUpperCase()}  `,
          "--to-import-id": `\t${TARGET_ID.toUpperCase()}\n`,
          "--target-url": `  ${targetUrl}  `,
        }),
        {}
      );
      expect(parsed.vendor).toBe("ss");
      expect(parsed.expectedCurrentImportId).toBe(CURRENT_ID);
      expect(parsed.toImportId).toBe(TARGET_ID);
      expect(parsed.targetUrl).toBe(targetUrl);
      expect(Object.keys(parsed)).not.toContain("targetUrl");
    }
  );

  it.each([
    "not a url",
    "   ",
    "https://db.internal/catalog",
    "postgres:///catalog",
    "postgres://db.internal",
    "postgresql://db.internal/",
    "postgres://rollback_user:credential-secret@/catalog",
  ])("rejects an invalid target URL without leaking it", (targetUrl) => {
    try {
      parseRollbackArgs(validArgv({ "--target-url": targetUrl }), {});
      throw new Error("expected target URL rejection");
    } catch (error) {
      expect((error as Error).message).toBe("Rollback argument error: target URL is invalid");
      expect(String(error)).not.toContain(targetUrl);
      expect(String(error)).not.toContain("credential-secret");
    }
  });

  it("accepts requested-by and reason values at their exact character limits", () => {
    const parsed = parseRollbackArgs(
      validArgv({ "--requested-by": "a".repeat(200), "--reason": "r".repeat(2000) }),
      {}
    );
    expect(parsed.requestedBy).toHaveLength(200);
    expect(parsed.reason).toHaveLength(2000);
  });

  it("never echoes credential-bearing unknown flags", () => {
    const databaseUrl = "postgresql://rollback_user:credential-secret@db.internal/catalog";
    const unknownFlag = `--${databaseUrl}`;
    try {
      parseRollbackArgs([...validArgv(), unknownFlag, "yes"], {});
      throw new Error("expected unknown flag rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Rollback argument error: unknown flag");
      expect(String(error)).not.toContain(databaseUrl);
      expect(String(error)).not.toContain("credential-secret");
      const serialized = JSON.stringify({ message: (error as Error).message });
      expect(serialized).not.toContain(databaseUrl);
      expect(serialized).not.toContain("credential-secret");
    }
  });

  it.each([
    ["missing vendor", validArgv().slice(2)],
    ["unsupported vendor", validArgv({ "--vendor": "alphabroder" })],
    ["missing current id", validArgv().filter((_, i) => i !== 2 && i !== 3)],
    ["malformed current id", validArgv({ "--expected-current-import-id": "not-a-uuid" })],
    ["malformed target id", validArgv({ "--to-import-id": "123" })],
    ["identical ids", validArgv({ "--to-import-id": CURRENT_ID })],
    ["blank actor", validArgv({ "--requested-by": "\u00a0\u2003" })],
    ["blank reason", validArgv({ "--reason": " \t\n" })],
    ["actor over limit after normalization", validArgv({ "--requested-by": ` ${"x".repeat(201)} ` })],
    ["reason over limit", validArgv({ "--reason": "x".repeat(2001) })],
    ["unknown flag", [...validArgv(), "--force", "yes"]],
    ["duplicate flag", [...validArgv(), "--vendor", "ss"]],
    ["missing value", [...validArgv().slice(0, -1), "--target-url"]],
    ["flag used as value", ["--vendor", "--reason", ...validArgv().slice(2)]],
    ["positional argument", [...validArgv(), "previous"]],
    ["equals syntax", ["--vendor=sanmar", ...validArgv().slice(2)]],
  ])("rejects %s", (_name, argv) => {
    expect(() => parseRollbackArgs(argv, {})).toThrow(/rollback argument/i);
  });

  it("requires an explicit target URL source and does not leak secrets in errors", () => {
    const argv = validArgv({ "--vendor": "invalid-secret-vendor" });
    argv.splice(argv.indexOf("--target-url"), 2);
    expect(() =>
      parseRollbackArgs(argv, {
        VENDOR_CATALOG_DATABASE_URL: "postgres://user:credential-secret@host/db",
      })
    ).toThrowError(/unsupported vendor/i);
    try {
      parseRollbackArgs(validArgv().filter((value) => value !== "--target-url" && value !== TARGET_URL), {});
    } catch (error) {
      expect(String(error)).not.toContain("credential-secret");
      expect(String(error)).not.toContain(TARGET_URL);
      expect(String(error)).toMatch(/target URL/i);
    }
  });
});

describe("inspectRollbackState", () => {
  it("uses read-only parameterized queries and returns only a bounded sanitized summary", async () => {
    const stateRow = {
      live_import_id: CURRENT_ID,
      live_import_status: "active",
      target_exists: true,
      target_vendor: "sanmar",
      target_status: "superseded",
      actual_style_count: "20",
      actual_variant_count: "100",
      stored_style_count: 20,
      stored_variant_count: 100,
      orphan_variant_count: "0",
      invalid_resolved_cost_count: "0",
      ss_basis_violation_count: "0",
      case_price_invariant_violation_count: "7",
      null_style_source_sync_at_count: "0",
      null_variant_source_sync_at_count: "0",
      known_style_present: true,
      target_source_sync_at: new Date("2026-08-01T12:00:00Z"),
      target_activated_at: new Date("2026-08-01T12:05:00Z"),
      target_imported_at: new Date("2026-08-01T11:55:00Z"),
      source_metadata: { password: "metadata-secret" },
      resolved_cost: "12.3400",
      database_url: TARGET_URL,
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [stateRow] })
      .mockResolvedValueOnce({
        rows: [
          { status: "running", status_count: "1", source_metadata: "secret" },
          { status: "queued", status_count: "2", credentials: "secret" },
          { status: "validating", status_count: "3", database_url: TARGET_URL },
        ],
      });

    const state = await inspectRollbackState(
      { query },
      {
        vendor: "sanmar",
        expectedCurrentImportId: CURRENT_ID,
        targetImportId: TARGET_ID,
      }
    );

    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql, params] of query.mock.calls) {
      expect(sql).not.toContain(CURRENT_ID);
      expect(sql).not.toContain(TARGET_ID);
      expect(sql).toMatch(/\$[123]/);
      expect(params).toEqual(expect.any(Array));
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|LOCK|FOR\s+UPDATE)\b/i);
    }
    expect(query.mock.calls[0][1]).toEqual(["sanmar", CURRENT_ID, TARGET_ID, "K500"]);
    expect(query.mock.calls[0][0]).toContain("vs.case_price_invariant_violation_count");
    expect(query.mock.calls[0][0]).toContain("WHERE $1 = 'ss' AND v.vendor = 'ss'");
    expect(query.mock.calls[0][0]).toContain("WHERE $1 = 'sanmar'");
    expect(query.mock.calls[1][1]).toEqual(["sanmar"]);
    expect(query.mock.calls[1][0]).toContain("LIMIT 3");
    expect(state).toEqual({
      vendor: "sanmar",
      expectedCurrentImportId: CURRENT_ID,
      targetImportId: TARGET_ID,
      live: { importId: CURRENT_ID, status: "active" },
      target: {
        exists: true,
        vendor: "sanmar",
        status: "superseded",
        actualStyleCount: 20,
        actualVariantCount: 100,
        storedStyleCount: 20,
        storedVariantCount: 100,
        orphanVariantCount: 0,
        invalidResolvedCostCount: 0,
        ssBasisViolationCount: 0,
        sanmarCasePriceInvariantViolationCount: 7,
        nullStyleSourceSyncAtCount: 0,
        nullVariantSourceSyncAtCount: 0,
        knownStylePresent: true,
        sourceSyncAt: new Date("2026-08-01T12:00:00Z"),
        activatedAt: new Date("2026-08-01T12:05:00Z"),
        importedAt: new Date("2026-08-01T11:55:00Z"),
      },
      nonTerminalJobs: {
        count: 6,
        statuses: [
          { status: "queued", count: 2 },
          { status: "running", count: 1 },
          { status: "validating", count: 3 },
        ],
      },
    });
    const serialized = JSON.stringify(state);
    for (const secret of ["metadata-secret", "12.3400", "database_url", "credentials", TARGET_URL]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("returns ssBasisViolationCount from database row", async () => {
    const row = {
      live_import_id: CURRENT_ID,
      live_import_status: "active",
      target_exists: true,
      target_vendor: "ss",
      target_status: "superseded",
      actual_style_count: "20",
      actual_variant_count: "100",
      stored_style_count: 20,
      stored_variant_count: 100,
      orphan_variant_count: "0",
      invalid_resolved_cost_count: "0",
      case_price_invariant_violation_count: "0",
      null_style_source_sync_at_count: "0",
      null_variant_source_sync_at_count: "0",
      known_style_present: true,
      target_source_sync_at: null,
      target_activated_at: null,
      target_imported_at: new Date("2026-08-01T11:55:00Z"),
      ss_basis_violation_count: "3",
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });
    const state = await inspectRollbackState(
      { query },
      { vendor: "ss", expectedCurrentImportId: CURRENT_ID, targetImportId: TARGET_ID }
    );
    expect((state.target as RollbackState["target"]).ssBasisViolationCount).toBe(3);
  });

  it("allows non-S&S inspection rows that omit ssBasisViolationCount", async () => {
    const row = {
      live_import_id: CURRENT_ID,
      live_import_status: "active",
      target_exists: true,
      target_vendor: "sanmar",
      target_status: "superseded",
      actual_style_count: "20",
      actual_variant_count: "100",
      stored_style_count: 20,
      stored_variant_count: 100,
      orphan_variant_count: "0",
      invalid_resolved_cost_count: "0",
      case_price_invariant_violation_count: "0",
      null_style_source_sync_at_count: "0",
      null_variant_source_sync_at_count: "0",
      known_style_present: true,
      target_source_sync_at: null,
      target_activated_at: null,
      target_imported_at: new Date("2026-08-01T11:55:00Z"),
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });
    const state = await inspectRollbackState(
      { query },
      { vendor: "sanmar", expectedCurrentImportId: CURRENT_ID, targetImportId: TARGET_ID }
    );
    expect((state.target as RollbackState["target"]).ssBasisViolationCount).toBe(0);
  });

  it("uses the SS known style and represents a missing target safely", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{
          target_exists: false,
          actual_style_count: "0",
          actual_variant_count: "0",
          stored_style_count: null,
          stored_variant_count: null,
          orphan_variant_count: "0",
          invalid_resolved_cost_count: "0",
          ss_basis_violation_count: "0",
          null_style_source_sync_at_count: "0",
          null_variant_source_sync_at_count: "0",
          known_style_present: false,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const state = await inspectRollbackState(
      { query },
      { vendor: "ss", expectedCurrentImportId: CURRENT_ID, targetImportId: TARGET_ID }
    );
    expect(query.mock.calls[0][1]).toEqual(["ss", CURRENT_ID, TARGET_ID, "3001"]);
    expect(state.live).toEqual({ importId: null, status: null });
    expect(state.target.exists).toBe(false);
    expect(state.target.storedStyleCount).toBeNull();
    expect(state.target.storedVariantCount).toBeNull();
    expect(state.nonTerminalJobs).toEqual({ count: 0, statuses: [] });
  });

  it("fails closed when the SanMar preflight result omits the case-price invariant count", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{
          live_import_id: CURRENT_ID,
          live_import_status: "active",
          target_exists: true,
          target_vendor: "sanmar",
          target_status: "superseded",
          actual_style_count: "20",
          actual_variant_count: "100",
          stored_style_count: 20,
          stored_variant_count: 100,
          orphan_variant_count: "0",
          invalid_resolved_cost_count: "0",
          null_style_source_sync_at_count: "0",
          null_variant_source_sync_at_count: "0",
          known_style_present: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      inspectRollbackState(
        { query },
        { vendor: "sanmar", expectedCurrentImportId: CURRENT_ID, targetImportId: TARGET_ID }
      )
    ).rejects.toThrowError("Rollback inspection error: invalid database result");
  });

  it.each([
    ["actual_style_count", null],
    ["actual_variant_count", "not-a-count"],
    ["stored_style_count", -1],
    ["stored_variant_count", "9007199254740992"],
    ["orphan_variant_count", " 0 "],
    ["invalid_resolved_cost_count", 1.5],
    ["null_style_source_sync_at_count", undefined],
    ["null_variant_source_sync_at_count", "-1"],
  ])("fails closed for malformed database count %s", async (field, value) => {
    const secret = "postgres://user:inspection-secret@db.internal/catalog";
    const row = {
      live_import_id: CURRENT_ID,
      live_import_status: "active",
      target_exists: true,
      target_vendor: "sanmar",
      target_status: "superseded",
      actual_style_count: "20",
      actual_variant_count: "100",
      stored_style_count: 20,
      stored_variant_count: 100,
      orphan_variant_count: "0",
      invalid_resolved_cost_count: "0",
      case_price_invariant_violation_count: "0",
      null_style_source_sync_at_count: "0",
      null_variant_source_sync_at_count: "0",
      known_style_present: true,
      [field]: value,
      credentials: secret,
    };
    const makeQueryable = () => ({
      query: vi.fn().mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] }),
    });
    await expect(
      inspectRollbackState(
        makeQueryable(),
        { vendor: "sanmar", expectedCurrentImportId: CURRENT_ID, targetImportId: TARGET_ID }
      )
    ).rejects.toThrowError("Rollback inspection error: invalid database result");
    try {
      await inspectRollbackState(
        makeQueryable(),
        { vendor: "sanmar", expectedCurrentImportId: CURRENT_ID, targetImportId: TARGET_ID }
      );
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      if (typeof value === "string" && value.length > 1) expect(String(error)).not.toContain(value);
    }
  });

  it.each([
    ["unknown status", [{ status: "postgres://user:job-secret@host/db", status_count: "1" }]],
    ["duplicate status", [{ status: "queued", status_count: "1" }, { status: "queued", status_count: "2" }]],
    ["null count", [{ status: "running", status_count: null }]],
    ["negative count", [{ status: "validating", status_count: "-1" }]],
    ["overflow count", [{ status: "queued", status_count: "9007199254740992" }]],
    ["overflow total", [
      { status: "queued", status_count: String(Number.MAX_SAFE_INTEGER) },
      { status: "running", status_count: "1" },
    ]],
    ["too many rows", [
      { status: "queued", status_count: "0" },
      { status: "running", status_count: "0" },
      { status: "validating", status_count: "0" },
      { status: "credential-secret", status_count: "0" },
    ]],
  ])("rejects malformed job aggregates: %s", async (_name, rows) => {
    const stateRow = {
      target_exists: false,
      actual_style_count: "0",
      actual_variant_count: "0",
      stored_style_count: null,
      stored_variant_count: null,
      orphan_variant_count: "0",
      invalid_resolved_cost_count: "0",
      ss_basis_violation_count: "0",
      null_style_source_sync_at_count: "0",
      null_variant_source_sync_at_count: "0",
      known_style_present: false,
    };
    const query = vi.fn().mockResolvedValueOnce({ rows: [stateRow] }).mockResolvedValueOnce({ rows });
    try {
      await inspectRollbackState(
        { query },
        { vendor: "ss", expectedCurrentImportId: CURRENT_ID, targetImportId: TARGET_ID }
      );
      throw new Error("expected malformed job aggregate rejection");
    } catch (error) {
      expect((error as Error).message).toBe("Rollback inspection error: invalid database result");
      expect(String(error)).not.toContain("job-secret");
      expect(String(error)).not.toContain("credential-secret");
    }
  });
});

describe("assertRollbackStateSafe", () => {
  it("returns a bounded validated summary", () => {
    const state = safeState();
    expect(assertRollbackStateSafe(state)).toEqual(state);
  });

  it("rejects a string target existence flag without leaking it", () => {
    const state = safeState({
      target: { ...safeState().target, exists: "false" },
    });

    try {
      assertRollbackStateSafe(state);
      throw new Error("expected target existence rejection");
    } catch (error) {
      expect((error as Error).message).toBe("Rollback preflight failed: target import was not found");
      expect(String(error)).not.toContain("false");
    }
  });

  it("normalizes validated vendor and UUID identities", () => {
    const result = assertRollbackStateSafe(safeState({
      vendor: "  ｓａｎｍａｒ  ",
      expectedCurrentImportId: `  ${CURRENT_ID.toUpperCase()}  `,
      targetImportId: `\t${TARGET_ID.toUpperCase()}\n`,
      live: { importId: CURRENT_ID.toUpperCase(), status: "active" },
    }));
    expect(result.vendor).toBe("sanmar");
    expect(result.expectedCurrentImportId).toBe(CURRENT_ID);
    expect(result.targetImportId).toBe(TARGET_ID);
    expect(result.live.importId).toBe(CURRENT_ID);
  });

  it.each([
    ["vendor", { vendor: "postgres://user:vendor-secret@host/db" }],
    ["expected id", { expectedCurrentImportId: "postgres://user:expected-secret@host/db" }],
    ["target id", { targetImportId: "postgres://user:target-secret@host/db" }],
    ["live id", { live: { importId: "postgres://user:live-secret@host/db", status: "active" } }],
    ["live status", { live: { importId: CURRENT_ID, status: "postgres://user:live-status-secret@host/db" } }],
    ["target status", { target: { ...safeState().target, status: "postgres://user:target-status-secret@host/db" } }],
  ])("rejects attacker-controlled %s without leaking it", (_name, override) => {
    try {
      assertRollbackStateSafe(safeState(override));
      throw new Error("expected identity rejection");
    } catch (error) {
      expect(String(error)).toMatch(/^Error: Rollback preflight failed:/);
      expect(String(error)).not.toContain("postgres://");
      expect(String(error)).not.toContain("secret");
    }
  });

  it.each(["queued", "running", "validating"])(
    "fails as active job for a positive %s aggregate",
    (status) => {
      expect(() => assertRollbackStateSafe(safeState({
        nonTerminalJobs: { count: 1, statuses: [{ status, count: 1 }] },
      }))).toThrow(/active non-terminal ingestion job/i);
    }
  );

  it.each([
    ["unknown status", { count: 0, statuses: [{ status: "credential-secret", count: 0 }] }],
    ["duplicate status", { count: 0, statuses: [{ status: "queued", count: 0 }, { status: "queued", count: 0 }] }],
    ["negative status count", { count: 0, statuses: [{ status: "running", count: -1 }] }],
    ["unsafe status count", { count: 0, statuses: [{ status: "validating", count: Number.MAX_SAFE_INTEGER + 1 }] }],
    ["too many entries", { count: 0, statuses: [
      { status: "queued", count: 0 },
      { status: "running", count: 0 },
      { status: "validating", count: 0 },
      { status: "queued", count: 0 },
    ] }],
    ["aggregate disagreement", { count: 0, statuses: [{ status: "queued", count: 1 }] }],
  ])("fails closed for malformed job summary: %s", (_name, nonTerminalJobs) => {
    try {
      assertRollbackStateSafe(safeState({ nonTerminalJobs }));
      throw new Error("expected job summary rejection");
    } catch (error) {
      expect(String(error)).toMatch(/Rollback preflight failed: ingestion job summary is invalid/i);
      expect(String(error)).not.toContain("credential-secret");
    }
  });

  it("normalizes pg Date objects and ISO-compatible timestamps", () => {
    const state = safeState({
      target: {
        ...safeState().target,
        sourceSyncAt: new Date("2026-08-01T12:00:00Z"),
        activatedAt: "2026-08-01T08:05:00-04:00",
        importedAt: new Date("2026-08-01T11:55:00Z"),
      },
    });
    expect(assertRollbackStateSafe(state).target).toMatchObject({
      sourceSyncAt: "2026-08-01T12:00:00.000Z",
      activatedAt: "2026-08-01T12:05:00.000Z",
      importedAt: "2026-08-01T11:55:00.000Z",
    });
  });

  it("allows a null activated timestamp", () => {
    const state = safeState({ target: { ...safeState().target, activatedAt: null } });
    expect(assertRollbackStateSafe(state).target.activatedAt).toBeNull();
  });

  it("allows a null import-level source timestamp when row-level watermarks are complete", () => {
    const state = safeState({ target: { ...safeState().target, sourceSyncAt: null } });
    expect(assertRollbackStateSafe(state).target.sourceSyncAt).toBeNull();
  });

  it.each(["sourceSyncAt", "activatedAt", "importedAt"])(
    "rejects invalid credential-bearing %s without leaking it",
    (field) => {
      const secret = "postgresql://rollback_user:timestamp-credential@db.internal/catalog";
      const state = safeState({ target: { ...safeState().target, [field]: secret } });
      try {
        assertRollbackStateSafe(state);
        throw new Error("expected timestamp rejection");
      } catch (error) {
        expect(String(error)).toMatch(/rollback preflight failed: target timestamp/i);
        expect(String(error)).not.toContain(secret);
        expect(String(error)).not.toContain("timestamp-credential");
        expect(JSON.stringify({ message: (error as Error).message })).not.toContain(secret);
      }
    }
  );

  it("requires target importedAt", () => {
    const field = "importedAt";
    const state = safeState({ target: { ...safeState().target, [field]: null } });
    expect(() => assertRollbackStateSafe(state)).toThrow(/target timestamp/i);
  });

  it.each([
    ["no active version", { live: { importId: null, status: null } }, /no active catalog/i],
    ["pointer mismatch", { live: { importId: TARGET_ID, status: "active" } }, /pointer mismatch/i],
    ["current inactive", { live: { importId: CURRENT_ID, status: "superseded" } }, /current import.*active/i],
    ["target missing", { target: { ...safeState().target, exists: false } }, /target import.*not found/i],
    ["wrong vendor", { target: { ...safeState().target, vendor: "ss" } }, /target import.*vendor/i],
    ["target not superseded", { target: { ...safeState().target, status: "ready" } }, /target import.*superseded/i],
    ["same ids", { targetImportId: CURRENT_ID }, /different/i],
    ["active job", { nonTerminalJobs: { count: 1, statuses: [{ status: "running", count: 1 }] } }, /ingestion job/i],
    ["style mismatch", { target: { ...safeState().target, storedStyleCount: 19 } }, /style count mismatch/i],
    ["variant mismatch", { target: { ...safeState().target, storedVariantCount: 99 } }, /variant count mismatch/i],
    ["zero styles", { target: { ...safeState().target, actualStyleCount: 0, storedStyleCount: 0 } }, /zero styles/i],
    ["zero variants", { target: { ...safeState().target, actualVariantCount: 0, storedVariantCount: 0 } }, /zero variants/i],
    ["orphans", { target: { ...safeState().target, orphanVariantCount: 1 } }, /orphan/i],
    ["invalid costs", { target: { ...safeState().target, invalidResolvedCostCount: 1 } }, /null, zero, or negative resolved costs/i],
    ["null style timestamps", { target: { ...safeState().target, nullStyleSourceSyncAtCount: 1 } }, /style source timestamps/i],
    ["null variant timestamps", { target: { ...safeState().target, nullVariantSourceSyncAtCount: 1 } }, /variant source timestamps/i],
    ["missing known style", { target: { ...safeState().target, knownStylePresent: false } }, /known style/i],
  ])("fails closed for %s", (_name, override, message) => {
    expect(() => assertRollbackStateSafe(safeState(override))).toThrow(message);
  });

  describe("S&S cost basis invariant", () => {
    it("rejects S&S target with non-piecePrice cost basis violations", () => {
      const state = safeState({
        vendor: "ss",
        target: { ...safeState().target, vendor: "ss", ssBasisViolationCount: 1 },
      });
      expect(() => assertRollbackStateSafe(state)).toThrow(/S&S piece price activation invariant/i);
    });

    it("accepts S&S target with zero basis violations and returns ssBasisViolationCount", () => {
      const state = safeState({
        vendor: "ss",
        target: { ...safeState().target, vendor: "ss", ssBasisViolationCount: 0 },
      });
      const result = assertRollbackStateSafe(state);
      expect(result.target).toHaveProperty("ssBasisViolationCount", 0);
    });

    it("treats ssBasisViolationCount as a required count field for validation", () => {
      const { ssBasisViolationCount: _removed, ...targetWithoutSsBasisViolationCount } = safeState().target;
      const state = safeState({
        vendor: "ss",
        target: { ...targetWithoutSsBasisViolationCount, vendor: "ss" },
      });
      // Without ssBasisViolationCount, the count validation should fail
      expect(() => assertRollbackStateSafe(state)).toThrow(/preflight failed/i);
    });
  });

  it("does not leak arbitrary fields or values through validation results or errors", () => {
    const secret = "postgres://user:credential@host/db metadata-secret cost=12.34 operator-reason";
    const unsafe = {
      ...safeState({ live: { importId: null, status: null } }),
      databaseUrl: secret,
      sourceMetadata: secret,
      resolvedCosts: [secret],
      reason: secret,
    };
    expect(() => assertRollbackStateSafe(unsafe)).toThrowError(/no active catalog/i);
    try {
      assertRollbackStateSafe(unsafe);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    const safeWithExtras = { ...safeState(), sourceMetadata: secret, reason: secret };
    const successful = assertRollbackStateSafe(safeWithExtras);
    expect(JSON.stringify(successful)).not.toContain(secret);
  });
});

describe("executeCatalogRollback transaction setup", () => {
  it("sets finite local timeouts immediately after BEGIN and before both advisory locks", async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, params?: readonly unknown[]) {
        calls.push({ sql, params });
        if (/SELECT import_id FROM active_catalog_versions/i.test(sql)) {
          return { rows: [{ import_id: CURRENT_ID }], rowCount: 1 };
        }
        if (/SELECT id, vendor, status FROM catalog_imports/i.test(sql)) {
          return { rows: [{ id: CURRENT_ID }, { id: TARGET_ID }], rowCount: 2 };
        }
        if (/WITH target AS/i.test(sql)) {
          return {
            rows: [{
              live_import_id: CURRENT_ID,
              live_import_status: "active",
              target_exists: true,
              target_vendor: "sanmar",
              target_status: "superseded",
              actual_style_count: "20",
              actual_variant_count: "100",
              stored_style_count: 20,
              stored_variant_count: 100,
              orphan_variant_count: "0",
              invalid_resolved_cost_count: "0",
              case_price_invariant_violation_count: "0",
              null_style_source_sync_at_count: "0",
              null_variant_source_sync_at_count: "0",
              known_style_present: true,
              target_source_sync_at: null,
              target_activated_at: null,
              target_imported_at: new Date("2026-08-01T11:55:00Z"),
            }],
            rowCount: 1,
          };
        }
        if (/case_price/i.test(sql) && /cost_basis/i.test(sql)) {
          return {
            rows: [{
              import_exists: true,
              import_vendor: "sanmar",
              expected_variant_count: 100,
              actual_variant_count: 100,
              non_sanmar_variant_count: 0,
              case_price_violation_count: 0,
            }],
            rowCount: 1,
          };
        }
        if (/FROM catalog_ingestion_jobs/i.test(sql)) return { rows: [], rowCount: 0 };
        if (/INSERT INTO catalog_rollbacks/i.test(sql)) {
          return { rows: [{ rolled_back_at: new Date("2026-08-23T12:00:00Z") }], rowCount: 1 };
        }
        return { rows: [], rowCount: /UPDATE/i.test(sql) ? 1 : 0 };
      },
      release: vi.fn(),
    };

    await executeCatalogRollback({ connect: async () => client }, {
      vendor: "sanmar",
      expectedCurrentImportId: CURRENT_ID,
      targetImportId: TARGET_ID,
      requestedBy: "Operator",
      reason: "Restore known-good catalog",
    });

    expect(calls.slice(0, 5)).toEqual([
      { sql: "BEGIN", params: undefined },
      { sql: expect.stringMatching(/set_config\('lock_timeout'/i), params: ["30000ms"] },
      { sql: expect.stringMatching(/set_config\('statement_timeout'/i), params: ["300000ms"] },
      { sql: expect.stringMatching(/pg_advisory_xact_lock/i), params: ["cmp-ingestion-lease:sanmar"] },
      { sql: expect.stringMatching(/pg_advisory_xact_lock/i), params: ["cmp-vendor-catalog:sanmar"] },
    ]);
  });

  it("issues the SanMar case-price invariant query in-transaction before pointer movement", async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, params?: readonly unknown[]) {
        calls.push({ sql, params });
        if (/SELECT import_id FROM active_catalog_versions/i.test(sql)) {
          return { rows: [{ import_id: CURRENT_ID }], rowCount: 1 };
        }
        if (/SELECT id, vendor, status FROM catalog_imports/i.test(sql)) {
          return { rows: [{ id: CURRENT_ID }, { id: TARGET_ID }], rowCount: 2 };
        }
        if (/WITH target AS/i.test(sql)) {
          return {
            rows: [{
              live_import_id: CURRENT_ID,
              live_import_status: "active",
              target_exists: true,
              target_vendor: "sanmar",
              target_status: "superseded",
              actual_style_count: "20",
              actual_variant_count: "100",
              stored_style_count: 20,
              stored_variant_count: 100,
              orphan_variant_count: "0",
              invalid_resolved_cost_count: "0",
              case_price_invariant_violation_count: "0",
              null_style_source_sync_at_count: "0",
              null_variant_source_sync_at_count: "0",
              known_style_present: true,
              target_source_sync_at: null,
              target_activated_at: null,
              target_imported_at: new Date("2026-08-01T11:55:00Z"),
            }],
            rowCount: 1,
          };
        }
        if (/FROM catalog_ingestion_jobs/i.test(sql)) return { rows: [], rowCount: 0 };
        if (/case_price/i.test(sql)) {
          return {
            rows: [{
              import_exists: true,
              import_vendor: "sanmar",
              expected_variant_count: 100,
              actual_variant_count: 100,
              non_sanmar_variant_count: 0,
              case_price_violation_count: 0,
            }],
            rowCount: 1,
          };
        }
        if (/INSERT INTO catalog_rollbacks/i.test(sql)) {
          return { rows: [{ rolled_back_at: new Date("2026-08-23T12:00:00Z") }], rowCount: 1 };
        }
        return { rows: [], rowCount: /UPDATE/i.test(sql) ? 1 : 0 };
      },
      release: vi.fn(),
    };

    await executeCatalogRollback({ connect: async () => client }, {
      vendor: "sanmar",
      expectedCurrentImportId: CURRENT_ID,
      targetImportId: TARGET_ID,
      requestedBy: "Operator",
      reason: "Restore known-good catalog",
    });

    const casePriceQuery = calls.find(
      (c) => /case_price/i.test(c.sql) && /cost_basis/i.test(c.sql) && c.params?.[0] === TARGET_ID
    );
    expect(casePriceQuery).toBeDefined();
    expect(casePriceQuery!.params).toEqual([TARGET_ID]);

    // Must occur after integrity check and before pointer update
    const casePriceIndex = calls.indexOf(casePriceQuery!);
    const integrityIndex = calls.findIndex((c) => /WITH target AS/i.test(c.sql));
    const pointerIndex = calls.findIndex((c) => /UPDATE active_catalog_versions/i.test(c.sql));
    expect(casePriceIndex).toBeGreaterThan(integrityIndex);
    expect(casePriceIndex).toBeLessThan(pointerIndex);
  });

  it("does not issue the SanMar case-price invariant query for SS rollbacks", async () => {
    const SS_CURRENT = "33333333-3333-4333-8333-333333333333";
    const SS_TARGET = "44444444-4444-4444-8444-444444444444";
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, params?: readonly unknown[]) {
        calls.push({ sql, params });
        if (/SELECT import_id FROM active_catalog_versions/i.test(sql)) {
          return { rows: [{ import_id: SS_CURRENT }], rowCount: 1 };
        }
        if (/SELECT id, vendor, status FROM catalog_imports/i.test(sql)) {
          return { rows: [{ id: SS_CURRENT }, { id: SS_TARGET }], rowCount: 2 };
        }
        if (/WITH target AS/i.test(sql)) {
          return {
            rows: [{
              live_import_id: SS_CURRENT,
              live_import_status: "active",
              target_exists: true,
              target_vendor: "ss",
              target_status: "superseded",
              actual_style_count: "20",
              actual_variant_count: "100",
              stored_style_count: 20,
              stored_variant_count: 100,
              orphan_variant_count: "0",
              invalid_resolved_cost_count: "0",
              ss_basis_violation_count: "0",
              null_style_source_sync_at_count: "0",
              null_variant_source_sync_at_count: "0",
              known_style_present: true,
              target_source_sync_at: null,
              target_activated_at: null,
              target_imported_at: new Date("2026-08-01T11:55:00Z"),
            }],
            rowCount: 1,
          };
        }
        if (/FROM catalog_ingestion_jobs/i.test(sql)) return { rows: [], rowCount: 0 };
        if (/piece_price/i.test(sql) && /cost_basis/i.test(sql)) {
          return {
            rows: [{
              import_exists: true,
              import_vendor: "ss",
              expected_variant_count: 100,
              actual_variant_count: 100,
              non_ss_variant_count: 0,
              piece_price_violation_count: 0,
            }],
            rowCount: 1,
          };
        }
        if (/INSERT INTO catalog_rollbacks/i.test(sql)) {
          return { rows: [{ rolled_back_at: new Date("2026-08-23T12:00:00Z") }], rowCount: 1 };
        }
        return { rows: [], rowCount: /UPDATE/i.test(sql) ? 1 : 0 };
      },
      release: vi.fn(),
    };

    await executeCatalogRollback({ connect: async () => client }, {
      vendor: "ss",
      expectedCurrentImportId: SS_CURRENT,
      targetImportId: SS_TARGET,
      requestedBy: "Operator",
      reason: "Restore known-good catalog",
    });

    expect(
      calls.some((c) => /case_price/i.test(c.sql) && /cost_basis/i.test(c.sql) && c.params?.[0] === SS_TARGET)
    ).toBe(false);
    expect(
      calls.some((c) => /piece_price/i.test(c.sql) && /cost_basis/i.test(c.sql) && c.params?.[0] === SS_TARGET)
    ).toBe(true);
  });
});
