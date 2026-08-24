import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { VENDOR_CATALOG_POSTGRES_SCHEMA_SQL } from '../../lib/server/vendor-catalog/postgres-schema.mjs';
import {
  executeCatalogRollback,
  inspectRollbackState,
} from '../lib/catalog-rollback.mjs';
import type {
  ExecuteCatalogRollbackOptions,
  RollbackTestHookPhase,
} from '../lib/catalog-rollback.mjs';

const TEST_PG_URL = process.env.VENDOR_CATALOG_TEST_DATABASE_URL;
const runIntegration = TEST_PG_URL != null && TEST_PG_URL.length > 0;
const SCHEMA_NAME = `test_catalog_rollback_${process.pid}_${randomUUID().replaceAll('-', '_')}`;
const SECRET_REASON = 'restore metadata-secret cost=12.3400';
const SECRET_ACTOR = 'operator-secret';

type Seed = { currentId: string; targetId: string };

describe.skipIf(!runIntegration)('atomic catalog rollback integration', () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: TEST_PG_URL, max: 1 });
    await adminPool.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
    pool = new pg.Pool({
      connectionString: TEST_PG_URL,
      max: 6,
      options: `-c search_path=${SCHEMA_NAME}`,
    });
  });

  beforeEach(async () => {
    await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
    await adminPool.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
    pool = new pg.Pool({
      connectionString: TEST_PG_URL,
      max: 6,
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

  async function seedPair(overrides: {
    targetVendor?: 'ss' | 'sanmar';
    targetStatus?: string;
    storedStyleCount?: number;
    targetStyleSync?: Date | null;
    targetImportSync?: Date | null;
  } = {}): Promise<Seed> {
    const currentId = randomUUID();
    const targetId = randomUUID();
    const targetVendor = overrides.targetVendor ?? 'sanmar';
    const targetStatus = overrides.targetStatus ?? 'superseded';
    await pool.query(
      `INSERT INTO catalog_imports
         (id, vendor, status, source_status, source_sync_at, activated_at,
          style_count, variant_count, source_metadata)
       VALUES
         ($1, 'sanmar', 'active', 'ok', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 1,
          '{"credential":"db-secret","cost":"99.99"}'::jsonb),
         ($2, $3, $4, 'ok', $6, CURRENT_TIMESTAMP, $5, 1,
          '{"credential":"target-secret","cost":"12.3400"}'::jsonb)`,
      [
        currentId,
        targetId,
        targetVendor,
        targetStatus,
        overrides.storedStyleCount ?? 1,
        overrides.targetImportSync === undefined ? new Date() : overrides.targetImportSync,
      ]
    );
    await pool.query(
      `INSERT INTO active_catalog_versions (vendor, import_id) VALUES ('sanmar', $1)`,
      [currentId]
    );
    for (const [importId, vendor, suffix, sync] of [
      [currentId, 'sanmar', 'current', new Date()],
      [targetId, targetVendor, 'target', overrides.targetStyleSync === undefined ? new Date() : overrides.targetStyleSync],
    ] as const) {
      await pool.query(
        `INSERT INTO catalog_styles
           (import_id, id, vendor, source_style_id, style_code, name, active_variant_count, source_sync_at)
         VALUES ($1, $2, $3, $4, 'K500', $5, 1, $6)`,
        [importId, `${vendor}:${suffix}:style`, vendor, `${suffix}:style`, `${suffix} retained`, sync]
      );
      await pool.query(
        `INSERT INTO catalog_variants
           (import_id, id, style_id, vendor, source_variant_id, style_code,
            resolved_cost, cost_basis, case_price, source_sync_at)
         VALUES ($1, $2, $3, $4, $5, 'K500', 12.34, 'casePrice', 12.34, CURRENT_TIMESTAMP)`,
        [importId, `${vendor}:${suffix}:variant`, `${vendor}:${suffix}:style`, vendor, `${suffix}:variant`]
      );
    }
    return { currentId, targetId };
  }

  function options(seed: Seed, hook?: (phase: RollbackTestHookPhase, client: pg.PoolClient) => Promise<void>): ExecuteCatalogRollbackOptions {
    return {
      vendor: 'sanmar',
      expectedCurrentImportId: seed.currentId,
      targetImportId: seed.targetId,
      requestedBy: `  ${SECRET_ACTOR}  `,
      reason: `  ${SECRET_REASON}  `,
      ...(hook ? { testHooks: { onPhase: hook } } : {}),
    };
  }

  async function snapshot() {
    const [pointer, imports, audits, styles] = await Promise.all([
      pool.query(`SELECT vendor, import_id FROM active_catalog_versions ORDER BY vendor`),
      pool.query(`SELECT id, vendor, status FROM catalog_imports ORDER BY id`),
      pool.query(`SELECT id, vendor, from_import_id, to_import_id, requested_by, reason, rolled_back_at FROM catalog_rollbacks ORDER BY rolled_back_at`),
      pool.query(`SELECT import_id, id, name FROM catalog_styles ORDER BY import_id, id`),
    ]);
    return { pointer: pointer.rows, imports: imports.rows, audits: audits.rows, styles: styles.rows };
  }

  function interceptedPool(
    intercept: (
      sql: string,
      params: readonly unknown[] | undefined,
      client: pg.PoolClient
    ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number } | undefined> | { rows: Record<string, unknown>[]; rowCount: number } | undefined
  ) {
    const tracker = { releases: 0 };
    const targetPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            const intercepted = await intercept(sql, params, client);
            if (intercepted !== undefined) return intercepted;
            return client.query(sql, params as unknown[] | undefined);
          },
          release() {
            tracker.releases += 1;
            client.release();
          },
        };
      },
    };
    return { targetPool, tracker };
  }

  async function expectRejectedWithoutSecrets(promise: Promise<unknown>, pattern?: RegExp) {
    try {
      await promise;
      throw new Error('expected rollback rejection');
    } catch (error) {
      const message = String(error);
      if (pattern) expect(message).toMatch(pattern);
      for (const secret of [SECRET_REASON, SECRET_ACTOR, 'db-secret', 'target-secret', '12.3400', TEST_PG_URL!]) {
        expect(message).not.toContain(secret);
      }
    }
  }

  async function waitForPostgresCondition(condition: () => Promise<boolean>, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('timed out waiting for PostgreSQL condition');
  }

  async function seedSSPair(overrides: {
    targetPiecePrice?: number | null;
    targetResolvedCost?: number;
    targetCostBasis?: string;
  } = {}): Promise<Seed> {
    const currentId = randomUUID();
    const targetId = randomUUID();
    await pool.query(
      `INSERT INTO catalog_imports
         (id, vendor, status, source_status, source_sync_at, activated_at,
          style_count, variant_count, source_metadata)
       VALUES
         ($1, 'ss', 'active', 'ok', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 1, '{}'::jsonb),
         ($2, 'ss', 'superseded', 'ok', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 1, '{}'::jsonb)`,
      [currentId, targetId]
    );
    await pool.query(
      `INSERT INTO active_catalog_versions (vendor, import_id) VALUES ('ss', $1)`,
      [currentId]
    );
    for (const [importId, suffix, pp, rc, cb] of [
      [currentId, 'current', 12.34, 12.34, 'piecePrice'],
      [targetId, 'target',
        overrides.targetPiecePrice !== undefined ? overrides.targetPiecePrice : 12.34,
        overrides.targetResolvedCost ?? 12.34,
        overrides.targetCostBasis ?? 'piecePrice'],
    ] as const) {
      await pool.query(
        `INSERT INTO catalog_styles
           (import_id, id, vendor, source_style_id, style_code, name, active_variant_count, source_sync_at)
         VALUES ($1, $2, 'ss', $3, '3001', $4, 1, CURRENT_TIMESTAMP)`,
        [importId, `ss:${suffix}:style`, `${suffix}:style`, `${suffix} retained`]
      );
      await pool.query(
        `INSERT INTO catalog_variants
           (import_id, id, style_id, vendor, source_variant_id, style_code,
            piece_price, resolved_cost, cost_basis, source_sync_at)
         VALUES ($1, $2, $3, 'ss', $4, '3001', $5, $6, $7, CURRENT_TIMESTAMP)`,
        [importId, `ss:${suffix}:variant`, `ss:${suffix}:style`, `${suffix}:variant`, pp, rc, cb]
      );
    }
    return { currentId, targetId };
  }

  function ssOptions(seed: Seed, hook?: (phase: RollbackTestHookPhase, client: pg.PoolClient) => Promise<void>): ExecuteCatalogRollbackOptions {
    return {
      vendor: 'ss',
      expectedCurrentImportId: seed.currentId,
      targetImportId: seed.targetId,
      requestedBy: SECRET_ACTOR,
      reason: SECRET_REASON,
      ...(hook ? { testHooks: { onPhase: hook } } : {}),
    };
  }

  it('rejects S&S rollback target with salePrice cost basis without changing state', async () => {
    const seed = await seedSSPair({ targetCostBasis: 'salePrice' });
    const before = await snapshot();
    await expectRejectedWithoutSecrets(
      executeCatalogRollback(pool, ssOptions(seed)),
      /piece price activation invariant/i
    );
    expect(await snapshot()).toEqual(before);
  });

  it('rejects S&S rollback target with zero piece price without changing state', async () => {
    const seed = await seedSSPair({ targetPiecePrice: 0, targetResolvedCost: 0 });
    const before = await snapshot();
    await expectRejectedWithoutSecrets(
      executeCatalogRollback(pool, ssOptions(seed)),
      /piece price activation invariant/i
    );
    expect(await snapshot()).toEqual(before);
  });

  it('rejects S&S rollback target with resolved_cost != piece_price without changing state', async () => {
    const seed = await seedSSPair({ targetPiecePrice: 5.00, targetResolvedCost: 4.00 });
    const before = await snapshot();
    await expectRejectedWithoutSecrets(
      executeCatalogRollback(pool, ssOptions(seed)),
      /piece price activation invariant/i
    );
    expect(await snapshot()).toEqual(before);
  });

  it('accepts valid S&S rollback target with piecePrice basis', async () => {
    const seed = await seedSSPair();
    const result = await executeCatalogRollback(pool, ssOptions(seed));
    expect(result).toMatchObject({
      rolledBack: true,
      vendor: 'ss',
      fromImportId: seed.currentId,
      toImportId: seed.targetId,
    });
    const after = await snapshot();
    expect(after.pointer.find((p: { vendor: string }) => p.vendor === 'ss')).toEqual({
      vendor: 'ss',
      import_id: seed.targetId,
    });
  });

  it('sanitizes client acquisition failures that contain connection credentials', async () => {
    const credentialUrl = `${TEST_PG_URL}?password=connection-secret`;
    const failingPool = {
      async connect() {
        throw new Error(`could not connect to ${credentialUrl}`);
      },
    };
    const seed = { currentId: randomUUID(), targetId: randomUUID() };
    await expectRejectedWithoutSecrets(
      executeCatalogRollback(failingPool, options(seed)),
      /transaction failed/i
    );
    await expect(executeCatalogRollback(failingPool, options(seed))).rejects.not.toThrow(/connection-secret/);
  });

  it('atomically switches the pointer and statuses, audits exact IDs, retains content, and returns a sanitized result', async () => {
    const seed = await seedPair();
    const before = await snapshot();
    const result = await executeCatalogRollback(pool, options(seed));
    const after = await snapshot();

    expect(result).toEqual({
      rolledBack: true,
      vendor: 'sanmar',
      fromImportId: seed.currentId,
      toImportId: seed.targetId,
      auditId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      rolledBackAt: expect.stringMatching(/Z$/),
      styleCount: 1,
      variantCount: 1,
    });
    expect(Object.keys(result).sort()).toEqual([
      'auditId', 'fromImportId', 'rolledBack', 'rolledBackAt', 'styleCount',
      'toImportId', 'variantCount', 'vendor',
    ].sort());
    expect(JSON.stringify(result)).not.toMatch(/reason|requested|metadata|cost|secret|url/i);
    expect(after.pointer).toEqual([{ vendor: 'sanmar', import_id: seed.targetId }]);
    expect(Object.fromEntries(after.imports.map((row) => [row.id, row.status]))).toEqual({
      [seed.currentId]: 'superseded',
      [seed.targetId]: 'active',
    });
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({
      id: result.auditId,
      vendor: 'sanmar',
      from_import_id: seed.currentId,
      to_import_id: seed.targetId,
      requested_by: SECRET_ACTOR,
      reason: SECRET_REASON,
    });
    expect(after.audits[0].rolled_back_at.toISOString()).toBe(result.rolledBackAt);
    expect(after.styles).toEqual(before.styles);
  });

  it('rolls back a real PostgreSQL target with null import source_sync_at and complete row watermarks', async () => {
    const seed = await seedPair({ targetImportSync: null });

    await expect(executeCatalogRollback(pool, options(seed))).resolves.toMatchObject({
      rolledBack: true,
      fromImportId: seed.currentId,
      toImportId: seed.targetId,
    });
    expect((await snapshot()).pointer).toEqual([{ vendor: 'sanmar', import_id: seed.targetId }]);
  });

  it('rejects pointer drift before execution and drift after read-only preflight without changing the drifted state', async () => {
    for (const preflight of [false, true]) {
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
      await adminPool.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
      pool = new pg.Pool({ connectionString: TEST_PG_URL, max: 6, options: `-c search_path=${SCHEMA_NAME}` });
      await pool.query(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL);
      const seed = await seedPair();
      if (preflight) {
        const state = await inspectRollbackState(pool, {
          vendor: 'sanmar', expectedCurrentImportId: seed.currentId, targetImportId: seed.targetId,
        });
        expect(state.live.importId).toBe(seed.currentId);
      }
      const replacementId = randomUUID();
      await pool.query(
        `INSERT INTO catalog_imports (id, vendor, status, source_status) VALUES ($1, 'sanmar', 'active', 'ok')`,
        [replacementId]
      );
      await pool.query(`UPDATE catalog_imports SET status = 'superseded' WHERE id = $1`, [seed.currentId]);
      await pool.query(`UPDATE active_catalog_versions SET import_id = $1 WHERE vendor = 'sanmar'`, [replacementId]);
      const before = await snapshot();
      await expectRejectedWithoutSecrets(executeCatalogRollback(pool, options(seed)), /pointer mismatch/i);
      expect(await snapshot()).toEqual(before);
    }
  });

  it('blocks active non-terminal jobs without changing state', async () => {
    for (const status of ['queued', 'running', 'validating']) {
      const seed = await seedPair();
      await pool.query(
        `INSERT INTO catalog_ingestion_jobs (id, vendor, status) VALUES ($1, 'sanmar', $2)`,
        [randomUUID(), status]
      );
      const before = await snapshot();
      await expectRejectedWithoutSecrets(executeCatalogRollback(pool, options(seed)), /non-terminal ingestion job/i);
      expect(await snapshot()).toEqual(before);
      if (status !== 'validating') {
        await pool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
        await adminPool.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
        pool = new pg.Pool({ connectionString: TEST_PG_URL, max: 6, options: `-c search_path=${SCHEMA_NAME}` });
        await pool.query(VENDOR_CATALOG_POSTGRES_SCHEMA_SQL);
      }
    }
  });

  it('waits for an ingestion lease transaction and rejects its newly committed queued job without changing catalog state', async () => {
    const seed = await seedPair();
    const before = await snapshot();
    const leaseClient = await pool.connect();
    const applicationName = `catalog-rollback-race-${process.pid}-${randomUUID().slice(0, 8)}`;
    const rollbackPool = new pg.Pool({
      connectionString: TEST_PG_URL,
      max: 1,
      options: `-c search_path=${SCHEMA_NAME}`,
      application_name: applicationName,
    });
    let leaseTransactionOpen = false;
    let reachedAfterLocks = false;

    try {
      await leaseClient.query('BEGIN');
      leaseTransactionOpen = true;
      await leaseClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'cmp-ingestion-lease:sanmar',
      ]);
      const queuedJobId = randomUUID();
      await leaseClient.query(
        `INSERT INTO catalog_ingestion_jobs (id, vendor, status) VALUES ($1, 'sanmar', 'queued')`,
        [queuedJobId]
      );

      const rollbackOutcome = executeCatalogRollback(rollbackPool, options(seed, async (phase) => {
        if (phase === 'afterAdvisoryLock') reachedAfterLocks = true;
      })).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error })
      );

      await waitForPostgresCondition(async () => {
        const activity = await adminPool.query(
          `SELECT wait_event_type, wait_event
             FROM pg_stat_activity
            WHERE application_name = $1`,
          [applicationName]
        );
        return activity.rows.some((row) =>
          row.wait_event_type === 'Lock' && row.wait_event === 'advisory'
        );
      });
      expect(reachedAfterLocks).toBe(false);
      expect(await snapshot()).toEqual(before);

      await leaseClient.query('COMMIT');
      leaseTransactionOpen = false;

      const outcome = await rollbackOutcome;
      expect(outcome.status).toBe('rejected');
      if (outcome.status !== 'rejected') throw new Error('rollback unexpectedly succeeded');
      expect(String(outcome.error)).toMatch(/non-terminal ingestion job/i);
      expect(reachedAfterLocks).toBe(true);
      expect(await snapshot()).toEqual(before);
      expect((await pool.query(
        `SELECT status FROM catalog_ingestion_jobs WHERE id = $1`,
        [queuedJobId]
      )).rows).toEqual([{ status: 'queued' }]);
    } finally {
      if (leaseTransactionOpen) await leaseClient.query('ROLLBACK');
      leaseClient.release();
      await rollbackPool.end();
    }
  });

  it('fails sanitized on a finite advisory lock timeout and leaves state unchanged', async () => {
    const seed = await seedPair();
    const before = await snapshot();
    const lockHolder = await pool.connect();
    let transactionOpen = false;
    try {
      await lockHolder.query('BEGIN');
      transactionOpen = true;
      await lockHolder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'cmp-ingestion-lease:sanmar',
      ]);
      const timeoutOptions = options(seed) as ExecuteCatalogRollbackOptions & {
        testHooks: { lockTimeoutMs: number };
      };
      timeoutOptions.testHooks = { lockTimeoutMs: 50 };

      await expectRejectedWithoutSecrets(
        executeCatalogRollback(pool, timeoutOptions),
        /^Error: Rollback transaction failed: operation aborted$/
      );
      expect(await snapshot()).toEqual(before);
    } finally {
      if (transactionOpen) await lockHolder.query('ROLLBACK');
      lockHolder.release();
    }
  });

  it.each([
    ['count mismatch', { storedStyleCount: 2 }, /style count mismatch/i],
    ['null source timestamp', { targetStyleSync: null }, /null style source timestamps/i],
  ] as const)('rejects real PostgreSQL target integrity fault: %s', async (_name, overrides, pattern) => {
    const seed = await seedPair(overrides);
    const before = await snapshot();
    await expectRejectedWithoutSecrets(executeCatalogRollback(pool, options(seed)), pattern);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['wrong vendor', { targetVendor: 'ss' as const }, /vendor does not match/i],
    ['non-superseded target', { targetStatus: 'ready' }, /not superseded/i],
  ])('rejects %s target without changing state', async (_name, overrides, pattern) => {
    const seed = await seedPair(overrides);
    const before = await snapshot();
    await expectRejectedWithoutSecrets(executeCatalogRollback(pool, options(seed)), pattern);
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back statuses, pointer, and inserted audit when an injected post-audit failure occurs', async () => {
    const seed = await seedPair();
    const before = await snapshot();
    await expectRejectedWithoutSecrets(
      executeCatalogRollback(pool, options(seed, async (phase) => {
        if (phase === 'afterAuditInsert') throw new Error(`${SECRET_REASON} ${TEST_PG_URL}`);
      })),
      /transaction failed/i
    );
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['hook', false],
    ['hook', true],
    ['database', false],
    ['database', true],
  ] as const)('sanitizes credential-bearing %s errors (trusted prefix: %s), rolls back, and releases', async (source, trustedPrefix) => {
    const seed = await seedPair();
    const before = await snapshot();
    const credential = 'postgresql://rollback_user:hook-db-secret@127.0.0.1/catalog';
    const rawMessage = trustedPrefix
      ? `Rollback preflight failed: ${credential}`
      : `driver failure for ${credential}`;
    const { targetPool, tracker } = interceptedPool(async (sql) => {
      if (source === 'database' && /UPDATE active_catalog_versions/i.test(sql)) {
        throw new Error(rawMessage);
      }
      return undefined;
    });
    const rollbackOptions = options(seed, async (phase) => {
      if (source === 'hook' && phase === 'afterAuditInsert') throw new Error(rawMessage);
    });

    let rejection: unknown;
    try {
      await executeCatalogRollback(targetPool, rollbackOptions);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('Rollback transaction failed: operation aborted');
    expect(String(rejection)).not.toMatch(/hook-db-secret|rollback_user|driver failure/i);
    expect(await snapshot()).toEqual(before);
    expect(tracker.releases).toBe(1);
  });

  it('requires audit INSERT rowCount 1 and rolls back statuses and pointer without persisting an audit row', async () => {
    const seed = await seedPair();
    const before = await snapshot();
    const { targetPool, tracker } = interceptedPool(async (sql) => {
      if (/INSERT INTO catalog_rollbacks/i.test(sql)) return { rows: [], rowCount: 0 };
      return undefined;
    });

    await expect(executeCatalogRollback(targetPool, options(seed))).rejects.toThrowError(
      'Rollback transaction failed: concurrent catalog change detected'
    );
    expect(await snapshot()).toEqual(before);
    expect((await snapshot()).audits).toHaveLength(0);
    expect(tracker.releases).toBe(1);
  });

  it.each([
    ['current status update', 'beforeCurrentUpdate' as const, async (client: pg.PoolClient, seed: Seed) => client.query(`UPDATE catalog_imports SET status = 'superseded' WHERE id = $1`, [seed.currentId])],
    ['target status update', 'beforeTargetUpdate' as const, async (client: pg.PoolClient, seed: Seed) => client.query(`UPDATE catalog_imports SET status = 'ready' WHERE id = $1`, [seed.targetId])],
    ['pointer compare-and-swap', 'beforePointerUpdate' as const, async (client: pg.PoolClient, _seed: Seed) => client.query(`DELETE FROM active_catalog_versions WHERE vendor = 'sanmar'`)],
  ])('requires rowCount 1 for %s and rolls back all changes', async (_name, injectedPhase, mutate) => {
    const seed = await seedPair();
    const before = await snapshot();
    await expectRejectedWithoutSecrets(executeCatalogRollback(pool, options(seed, async (phase, client) => {
      if (phase === injectedPhase) await mutate(client, seed);
    })), /transaction failed/i);
    expect(await snapshot()).toEqual(before);
  });

  it('does not silently toggle on a second identical invocation', async () => {
    const seed = await seedPair();
    await executeCatalogRollback(pool, options(seed));
    const afterFirst = await snapshot();
    await expectRejectedWithoutSecrets(executeCatalogRollback(pool, options(seed)), /pointer mismatch/i);
    expect(await snapshot()).toEqual(afterFirst);
    expect(afterFirst.audits).toHaveLength(1);
  });

  it('serializes concurrent attempts for one vendor so exactly one succeeds', async () => {
    const seed = await seedPair();
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstLocked!: () => void;
    const firstHasLock = new Promise<void>((resolve) => { firstLocked = resolve; });
    const first = executeCatalogRollback(pool, options(seed, async (phase) => {
      if (phase === 'afterAdvisoryLock') {
        firstLocked();
        await firstMayFinish;
      }
    }));
    await firstHasLock;
    const second = executeCatalogRollback(pool, options(seed));
    releaseFirst();
    const settled = await Promise.allSettled([first, second]);
    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    const state = await snapshot();
    expect(state.audits).toHaveLength(1);
    expect(state.pointer).toEqual([{ vendor: 'sanmar', import_id: seed.targetId }]);
  });

  async function seedCasePricePair(overrides: {
    targetCostBasis?: string;
    targetCasePrice?: number | null;
    targetResolvedCost?: number;
  } = {}): Promise<Seed> {
    const currentId = randomUUID();
    const targetId = randomUUID();
    const costBasis = overrides.targetCostBasis ?? 'casePrice';
    const casePrice = overrides.targetCasePrice === undefined ? 12.34 : overrides.targetCasePrice;
    const resolvedCost = overrides.targetResolvedCost ?? 12.34;
    await pool.query(
      `INSERT INTO catalog_imports
         (id, vendor, status, source_status, source_sync_at, activated_at,
          style_count, variant_count, source_metadata)
       VALUES
         ($1, 'sanmar', 'active', 'ok', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 1,
          '{}'::jsonb),
         ($2, 'sanmar', 'superseded', 'ok', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 1,
          '{}'::jsonb)`,
      [currentId, targetId]
    );
    await pool.query(
      `INSERT INTO active_catalog_versions (vendor, import_id) VALUES ('sanmar', $1)`,
      [currentId]
    );
    for (const [importId, suffix, cb, cp, rc] of [
      [currentId, 'current', 'casePrice', 12.34, 12.34],
      [targetId, 'target', costBasis, casePrice, resolvedCost],
    ] as const) {
      await pool.query(
        `INSERT INTO catalog_styles
           (import_id, id, vendor, source_style_id, style_code, name, active_variant_count, source_sync_at)
         VALUES ($1, $2, 'sanmar', $3, 'K500', $3, 1, CURRENT_TIMESTAMP)`,
        [importId, `sanmar:${suffix}:style`, `${suffix}:style`]
      );
      await pool.query(
        `INSERT INTO catalog_variants
           (import_id, id, style_id, vendor, source_variant_id, style_code,
            resolved_cost, cost_basis, case_price, source_sync_at)
         VALUES ($1, $2, $3, 'sanmar', $4, 'K500', $5, $6, $7, CURRENT_TIMESTAMP)`,
        [importId, `sanmar:${suffix}:variant`, `sanmar:${suffix}:style`, `${suffix}:variant`, rc, cb, cp]
      );
    }
    return { currentId, targetId };
  }

  it('rejects rollback to SanMar target with piecePrice basis without changing state', async () => {
    const seed = await seedCasePricePair({ targetCostBasis: 'piecePrice' });
    const before = await snapshot();
    await expectRejectedWithoutSecrets(
      executeCatalogRollback(pool, options(seed)),
      /case-price invariant/i
    );
    expect(await snapshot()).toEqual(before);
  });

  it('rejects rollback to SanMar target with null case_price without changing state', async () => {
    const seed = await seedCasePricePair({ targetCasePrice: null });
    const before = await snapshot();
    await expectRejectedWithoutSecrets(
      executeCatalogRollback(pool, options(seed)),
      /case-price invariant/i
    );
    expect(await snapshot()).toEqual(before);
  });

  it('rejects rollback to SanMar target with zero case_price without changing state', async () => {
    const seed = await seedCasePricePair({ targetCasePrice: 0, targetResolvedCost: 0 });
    const before = await snapshot();
    await expectRejectedWithoutSecrets(
      executeCatalogRollback(pool, options(seed)),
      /case-price invariant/i
    );
    expect(await snapshot()).toEqual(before);
  });

  it('rejects rollback to SanMar target with resolved_cost != case_price without changing state', async () => {
    const seed = await seedCasePricePair({ targetResolvedCost: 99.99 });
    const before = await snapshot();
    await expectRejectedWithoutSecrets(
      executeCatalogRollback(pool, options(seed)),
      /case-price invariant/i
    );
    expect(await snapshot()).toEqual(before);
  });

  it('accepts rollback to SanMar target with valid casePrice data', async () => {
    const seed = await seedCasePricePair();
    const result = await executeCatalogRollback(pool, options(seed));
    expect(result).toMatchObject({
      rolledBack: true,
      vendor: 'sanmar',
      fromImportId: seed.currentId,
      toImportId: seed.targetId,
    });
    const after = await snapshot();
    expect(after.pointer).toEqual([{ vendor: 'sanmar', import_id: seed.targetId }]);
    expect(after.audits).toHaveLength(1);
  });
});
