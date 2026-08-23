import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { main } from "../rollback-vendor-catalog.mjs";
import {
  assertRollbackStateSafe,
  executeCatalogRollback,
  safeRollbackErrorMessage,
} from "../lib/catalog-rollback.mjs";
import { VENDOR_CATALOG_POSTGRES_SCHEMA_SQL } from "../../lib/server/vendor-catalog/postgres-schema.mjs";

const CURRENT_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_URL = "postgresql://rollback_user:credential-secret@db.internal/catalog";
const REASON = "First delta verification rollback metadata-secret cost=12.3400";
const ACTOR = "paulcmpdev-actor-secret";
const SAFE_STATE = { safe: true };
const RESULT = {
  rolledBack: true,
  vendor: "sanmar",
  fromImportId: CURRENT_ID,
  toImportId: TARGET_ID,
  auditId: "33333333-3333-4333-8333-333333333333",
  rolledBackAt: "2026-08-23T12:00:00.000Z",
  styleCount: 1,
  variantCount: 2,
};

function validArgv(overrides: Record<string, string | null> = {}) {
  const values: Record<string, string> = {
    "--vendor": "sanmar",
    "--expected-current-import-id": CURRENT_ID,
    "--to-import-id": TARGET_ID,
    "--requested-by": ACTOR,
    "--reason": REASON,
    "--target-url": TARGET_URL,
  };
  for (const [flag, value] of Object.entries(overrides)) {
    if (value === null) delete values[flag];
    else values[flag] = value;
  }
  return Object.entries(values).flat();
}

function harness(overrides: Record<string, unknown> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const pool = { query: vi.fn().mockResolvedValue({ rows: [] }), end: vi.fn().mockResolvedValue(undefined) };
  const Pool = vi.fn(function Pool() { return pool; });
  const inspect = vi.fn().mockResolvedValue(SAFE_STATE);
  const assertSafe = vi.fn().mockReturnValue(SAFE_STATE);
  const execute = vi.fn().mockResolvedValue(RESULT);
  const signals = new Map<string, () => void>();
  const registeredSignals: string[] = [];
  const signalCleanups = new Map<string, ReturnType<typeof vi.fn>>();
  const registerSignal = (signal: string, handler: () => void) => {
    registeredSignals.push(signal);
    signals.set(signal, handler);
    const cleanup = vi.fn(() => { signals.delete(signal); });
    signalCleanups.set(signal, cleanup);
    return cleanup;
  };
  const dependencies: any = {
    argv: validArgv(),
    env: {},
    Pool,
    stdout: { write: (value: string) => { stdout.push(value); } },
    stderr: { write: (value: string) => { stderr.push(value); } },
    registerSignal,
    inspect,
    assertSafe,
    execute,
    schemaSql: "SCHEMA SQL",
    ...overrides,
  };
  return {
    dependencies, stdout, stderr, pool, Pool, inspect, assertSafe, execute,
    signals, registeredSignals, signalCleanups,
  };
}

function combinedOutput(h: ReturnType<typeof harness>) {
  return `${h.stdout.join("")}${h.stderr.join("")}`;
}

function expectNoSecrets(output: string) {
  for (const secret of [TARGET_URL, "credential-secret", REASON, ACTOR, "metadata-secret", "12.3400"]) {
    expect(output).not.toContain(secret);
  }
}

function capturedPreflightError() {
  try {
    assertRollbackStateSafe({
      vendor: "sanmar",
      expectedCurrentImportId: CURRENT_ID,
      targetImportId: TARGET_ID,
      live: { importId: TARGET_ID, status: "active" },
    } as any);
  } catch (error) {
    return error;
  }
  throw new Error("expected the real preflight path to reject");
}

async function capturedTransactionError() {
  try {
    await executeCatalogRollback({} as any, {
      vendor: "sanmar",
      expectedCurrentImportId: CURRENT_ID,
      targetImportId: TARGET_ID,
      requestedBy: ACTOR,
      reason: REASON,
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected the real transaction path to reject");
}

describe("catalog rollback CLI", () => {
  it.each([
    ["missing flag", validArgv({ "--vendor": null })],
    ["invalid flag", [...validArgv(), "--previous", "yes"]],
    ["no explicit target", validArgv({ "--to-import-id": null })],
  ])("rejects %s before constructing a pool", async (_name, argv) => {
    const h = harness({ argv });
    expect(await main(h.dependencies)).toBe(1);
    expect(h.Pool).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toHaveLength(1);
    expectNoSecrets(combinedOutput(h));
  });

  it("sanitizes pool construction failures containing credentials", async () => {
    const Pool = vi.fn(function Pool() {
      throw new Error(`cannot connect to ${TARGET_URL} reason=${REASON} actor=${ACTOR}`);
    });
    const h = harness({ Pool });
    expect(await main(h.dependencies)).toBe(1);
    expect(h.stderr).toEqual(["{\"error\":\"Catalog rollback failed\"}\n"]);
    expectNoSecrets(combinedOutput(h));
  });

  it("sanitizes schema failures and ends the pool", async () => {
    const h = harness();
    h.pool.query.mockRejectedValue(new Error(`schema failed at ${TARGET_URL} metadata-secret 12.3400`));
    expect(await main(h.dependencies)).toBe(1);
    expect(h.stderr).toEqual(["{\"error\":\"Catalog rollback failed\"}\n"]);
    expect(h.pool.end).toHaveBeenCalledOnce();
    expect(h.inspect).not.toHaveBeenCalled();
    expect(h.signals.size).toBe(0);
    expect(h.signalCleanups.get("SIGINT")).toHaveBeenCalledOnce();
    expect(h.signalCleanups.get("SIGTERM")).toHaveBeenCalledOnce();
    expectNoSecrets(combinedOutput(h));
  });

  it("stops after a sanitized preflight failure and ends the pool", async () => {
    const error = capturedPreflightError();
    expect(safeRollbackErrorMessage(error)).toBe("Rollback preflight failed: current catalog pointer mismatch");
    const h = harness({ assertSafe: vi.fn(() => { throw error; }) });
    expect(await main(h.dependencies)).toBe(1);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pool.end).toHaveBeenCalledOnce();
    expect(h.stderr).toEqual(["{\"error\":\"Rollback preflight failed: current catalog pointer mismatch\"}\n"]);
    expectNoSecrets(combinedOutput(h));
  });

  it("checks a signal abort immediately before execute", async () => {
    const h = harness({
      assertSafe: vi.fn((state) => {
        h.signals.get("SIGINT")?.();
        return state;
      }),
    });
    expect(await main(h.dependencies)).toBe(1);
    expect(h.registeredSignals).toEqual(["SIGINT", "SIGTERM"]);
    expect(h.signals.size).toBe(0);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pool.end).toHaveBeenCalledOnce();
    expect(h.stderr).toEqual(["{\"error\":\"Rollback aborted before execution\"}\n"]);
    expectNoSecrets(combinedOutput(h));
  });

  it("applies schema, preflights exact IDs, executes exact safe fields, and prints one JSON line", async () => {
    const h = harness();
    h.execute.mockImplementation(async () => {
      expect(h.signals.size).toBe(0);
      expect(h.signalCleanups.get("SIGINT")).toHaveBeenCalledOnce();
      expect(h.signalCleanups.get("SIGTERM")).toHaveBeenCalledOnce();
      return RESULT;
    });
    expect(await main(h.dependencies)).toBe(0);
    expect(h.Pool).toHaveBeenCalledWith({ connectionString: TARGET_URL });
    expect(h.pool.query).toHaveBeenCalledWith("SCHEMA SQL");
    expect(h.inspect).toHaveBeenCalledWith(h.pool, {
      vendor: "sanmar",
      expectedCurrentImportId: CURRENT_ID,
      targetImportId: TARGET_ID,
    });
    expect(h.assertSafe).toHaveBeenCalledWith(SAFE_STATE);
    expect(h.execute).toHaveBeenCalledWith(h.pool, {
      vendor: "sanmar",
      expectedCurrentImportId: CURRENT_ID,
      targetImportId: TARGET_ID,
      requestedBy: ACTOR,
      reason: REASON,
    });
    expect(h.pool.query.mock.invocationCallOrder[0]).toBeLessThan(h.inspect.mock.invocationCallOrder[0]);
    expect(h.inspect.mock.invocationCallOrder[0]).toBeLessThan(h.execute.mock.invocationCallOrder[0]);
    expect(h.stdout).toEqual([`${JSON.stringify(RESULT)}\n`]);
    expect(h.stderr).toEqual([]);
    expect(h.pool.end).toHaveBeenCalledOnce();
    expectNoSecrets(combinedOutput(h));
  });

  it("default signal registration removes process handlers before execute", async () => {
    const on = vi.spyOn(process, "on");
    const off = vi.spyOn(process, "off");
    const h = harness();
    delete h.dependencies.registerSignal;
    h.execute.mockImplementation(async () => {
      expect(off.mock.calls.filter(([signal]) => signal === "SIGINT")).toHaveLength(1);
      expect(off.mock.calls.filter(([signal]) => signal === "SIGTERM")).toHaveLength(1);
      return RESULT;
    });
    try {
      expect(await main(h.dependencies)).toBe(0);
      expect(on.mock.calls.some(([signal]) => signal === "SIGINT")).toBe(true);
      expect(on.mock.calls.some(([signal]) => signal === "SIGTERM")).toBe(true);
    } finally {
      on.mockRestore();
      off.mockRestore();
    }
  });

  it("preserves a committed success when pool cleanup fails afterward", async () => {
    const h = harness();
    h.pool.end.mockRejectedValue(new Error(`${TARGET_URL} cleanup metadata-secret`));

    expect(await main(h.dependencies)).toBe(0);
    expect(h.stdout).toEqual([`${JSON.stringify(RESULT)}\n`]);
    expect(h.stderr).toEqual([]);
    expect(h.pool.end).toHaveBeenCalledOnce();
    expectNoSecrets(combinedOutput(h));
  });

  it("prints one sanitized transaction failure line and ends the pool", async () => {
    const error = await capturedTransactionError();
    expect(safeRollbackErrorMessage(error)).toBe("Rollback transaction failed: invalid target pool");
    const h = harness({ execute: vi.fn(() => { throw error; }) });
    expect(await main(h.dependencies)).toBe(1);
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toEqual(["{\"error\":\"Rollback transaction failed: invalid target pool\"}\n"]);
    expect(h.pool.end).toHaveBeenCalledOnce();
    expectNoSecrets(combinedOutput(h));
  });

  it("uses one generic failure when pool cleanup fails before any success", async () => {
    const h = harness({
      execute: vi.fn(() => { throw new Error(`${TARGET_URL} execution metadata-secret`); }),
    });
    h.pool.end.mockRejectedValue(new Error(`${REASON} cleanup actor=${ACTOR}`));

    expect(await main(h.dependencies)).toBe(1);
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toEqual(["{\"error\":\"Catalog rollback failed\"}\n"]);
    expect(h.pool.end).toHaveBeenCalledOnce();
    expectNoSecrets(combinedOutput(h));
  });

  it("replaces unexpected execution errors instead of leaking URL, actor, reason, metadata, or costs", async () => {
    const h = harness({ execute: vi.fn(() => { throw new Error(`${TARGET_URL} ${ACTOR} ${REASON}`); }) });
    expect(await main(h.dependencies)).toBe(1);
    expect(h.stderr).toEqual(["{\"error\":\"Catalog rollback failed\"}\n"]);
    expectNoSecrets(combinedOutput(h));
  });

  it("does not trust a forged rollback preflight error prefix", async () => {
    const forged = new Error("Rollback preflight failed: credential-secret");
    expect(safeRollbackErrorMessage(forged)).toBeNull();
    const h = harness({ execute: vi.fn(() => { throw forged; }) });
    expect(await main(h.dependencies)).toBe(1);
    expect(h.stderr).toEqual(["{\"error\":\"Catalog rollback failed\"}\n"]);
    expect(combinedOutput(h)).not.toContain("credential-secret");
  });

  it("does not trust an object forged from a captured private error prototype", () => {
    const genuine = capturedPreflightError();
    const forged = Object.assign(Object.create(Object.getPrototypeOf(genuine)), {
      message: "Rollback preflight failed: credential-secret",
    });
    expect(safeRollbackErrorMessage(forged)).toBeNull();
  });

  it("does not execute when imported", () => {
    const scriptUrl = pathToFileURL(new URL("../rollback-vendor-catalog.mjs", import.meta.url).pathname).href;
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(scriptUrl)})`], {
      encoding: "utf8",
      env: { ...process.env, VENDOR_CATALOG_DATABASE_URL: TARGET_URL },
    });
    expect(output).toBe("");
  });

  it("exposes the exact package rollback command", () => {
    const packagePath = new URL("../../package.json", import.meta.url);
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    expect(packageJson.scripts["catalog:rollback"]).toBe("node scripts/rollback-vendor-catalog.mjs");
  });
});

const TEST_PG_URL = process.env.VENDOR_CATALOG_TEST_DATABASE_URL;

describe.skipIf(!TEST_PG_URL)("catalog rollback CLI PostgreSQL", () => {
  it("executes the main path and changes the real pointer, statuses, and audit", async () => {
    const schema = `test_catalog_rollback_cli_${process.pid}_${randomUUID().replaceAll("-", "_")}`;
    const admin = new pg.Pool({ connectionString: TEST_PG_URL, max: 1 });
    const poolOptions = { connectionString: TEST_PG_URL, options: `-c search_path=${schema}` };
    let setup: pg.Pool | undefined;
    let verify: pg.Pool | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      setup = new pg.Pool(poolOptions);
      await setup.query(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL);
      const currentId = randomUUID();
      const targetId = randomUUID();
      await setup.query(
        `INSERT INTO catalog_imports
           (id, vendor, status, source_status, source_sync_at, activated_at, style_count, variant_count)
         VALUES ($1, 'sanmar', 'active', 'ok', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 1),
                ($2, 'sanmar', 'superseded', 'ok', NULL, CURRENT_TIMESTAMP, 1, 1)`,
        [currentId, targetId]
      );
      await setup.query(
        `INSERT INTO active_catalog_versions (vendor, import_id) VALUES ('sanmar', $1)`,
        [currentId]
      );
      for (const [id, suffix] of [[currentId, "current"], [targetId, "target"]]) {
        await setup.query(
          `INSERT INTO catalog_styles
             (import_id, id, vendor, source_style_id, style_code, name, active_variant_count, source_sync_at)
           VALUES ($1, $2, 'sanmar', $3, 'K500', $3, 1, CURRENT_TIMESTAMP)`,
          [id, `sanmar:${suffix}:style`, suffix]
        );
        await setup.query(
          `INSERT INTO catalog_variants
             (import_id, id, style_id, vendor, source_variant_id, style_code,
              resolved_cost, cost_basis, source_sync_at)
           VALUES ($1, $2, $3, 'sanmar', $4, 'K500', 12.34, 'piecePrice', CURRENT_TIMESTAMP)`,
          [id, `sanmar:${suffix}:variant`, `sanmar:${suffix}:style`, suffix]
        );
      }
      await setup.end();
      setup = undefined;

      const stdout: string[] = [];
      const stderr: string[] = [];
      class IsolatedPool extends pg.Pool {
        constructor(options: pg.PoolConfig) {
          expect(options).toEqual({ connectionString: TEST_PG_URL });
          super({ ...options, options: `-c search_path=${schema}` });
        }
      }
      const exitCode = await main({
        argv: validArgv({
          "--expected-current-import-id": currentId,
          "--to-import-id": targetId,
          "--target-url": TEST_PG_URL!,
        }),
        env: {},
        Pool: IsolatedPool,
        stdout: { write(value: string) { stdout.push(value); } },
        stderr: { write(value: string) { stderr.push(value); } },
        registerSignal: () => undefined,
      } as any);

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout).toHaveLength(1);
      const result = JSON.parse(stdout[0]);
      expect(result).toMatchObject({
        rolledBack: true,
        vendor: "sanmar",
        fromImportId: currentId,
        toImportId: targetId,
      });
      expectNoSecrets(stdout[0]);

      verify = new pg.Pool(poolOptions);
      const [pointer, statuses, audit] = await Promise.all([
        verify.query(`SELECT import_id FROM active_catalog_versions WHERE vendor = 'sanmar'`),
        verify.query(`SELECT id, status FROM catalog_imports WHERE id = ANY($1::uuid[])`, [[currentId, targetId]]),
        verify.query(`SELECT from_import_id, to_import_id, requested_by, reason FROM catalog_rollbacks`),
      ]);
      expect(pointer.rows).toEqual([{ import_id: targetId }]);
      expect(Object.fromEntries(statuses.rows.map((row) => [row.id, row.status]))).toEqual({
        [currentId]: "superseded",
        [targetId]: "active",
      });
      expect(audit.rows).toEqual([{
        from_import_id: currentId,
        to_import_id: targetId,
        requested_by: ACTOR,
        reason: REASON,
      }]);
    } finally {
      if (setup) await setup.end();
      if (verify) await verify.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
});
