#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import pg from "pg";
import { VENDOR_CATALOG_POSTGRES_SCHEMA_SQL } from "../lib/server/vendor-catalog/postgres-schema.mjs";
import {
  assertRollbackStateSafe,
  executeCatalogRollback,
  inspectRollbackState,
  parseRollbackArgs,
  safeRollbackErrorMessage,
} from "./lib/catalog-rollback.mjs";

const { Pool } = pg;
const GENERIC_ERROR = "Catalog rollback failed";
const ABORT_ERROR = "Rollback aborted before execution";

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  Pool: PoolConstructor = Pool,
  stdout = process.stdout,
  stderr = process.stderr,
  registerSignal = (signal, handler) => {
    process.on(signal, handler);
    return () => process.off(signal, handler);
  },
  inspect = inspectRollbackState,
  assertSafe = assertRollbackStateSafe,
  execute = executeCatalogRollback,
  schemaSql = VENDOR_CATALOG_POSTGRES_SCHEMA_SQL,
} = {}) {
  let pool;
  let result;
  let failure;
  const signalCleanups = [];
  const cleanupSignals = () => {
    for (const cleanup of signalCleanups.splice(0)) {
      try { cleanup(); } catch { /* best-effort handler restoration */ }
    }
  };

  try {
    const parsed = parseRollbackArgs(argv, env);
    let aborted = false;
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const cleanup = registerSignal(signal, () => { aborted = true; });
      if (typeof cleanup === "function") signalCleanups.push(cleanup);
    }

    pool = new PoolConstructor({ connectionString: parsed.targetUrl });
    await pool.query(schemaSql);

    const inspection = await inspect(pool, {
      vendor: parsed.vendor,
      expectedCurrentImportId: parsed.expectedCurrentImportId,
      targetImportId: parsed.toImportId,
    });
    assertSafe(inspection);

    cleanupSignals();
    if (aborted) {
      failure = ABORT_ERROR;
    } else {
      result = await execute(pool, {
        vendor: parsed.vendor,
        expectedCurrentImportId: parsed.expectedCurrentImportId,
        targetImportId: parsed.toImportId,
        requestedBy: parsed.requestedBy,
        reason: parsed.reason,
      });
    }
  } catch (error) {
    failure = safeRollbackErrorMessage(error) ?? GENERIC_ERROR;
  } finally {
    cleanupSignals();
    if (pool) {
      try {
        await pool.end();
      } catch {
        if (result === undefined) {
          failure = GENERIC_ERROR;
        }
      }
    }
  }

  if (failure) {
    stderr.write(`${JSON.stringify({ error: failure })}\n`);
    return 1;
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

const isDirectExecution = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  process.exitCode = await main();
}