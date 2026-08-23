import { randomUUID } from "node:crypto";

const FLAGS = new Set([
  "--vendor",
  "--expected-current-import-id",
  "--to-import-id",
  "--requested-by",
  "--reason",
  "--target-url",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN_STYLES = { sanmar: "K500", ss: "3001" };

const safeRollbackErrorMessages = new WeakMap();

class SafeRollbackError extends Error {
  constructor(message) {
    super(message);
    safeRollbackErrorMessages.set(this, message);
  }
}

export function safeRollbackErrorMessage(error) {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") return null;
  return safeRollbackErrorMessages.get(error) ?? null;
}

function argumentError(message) {
  return new SafeRollbackError(`Rollback argument error: ${message}`);
}

function normalizedText(value, flag, maximum) {
  const normalized = value.normalize("NFKC").trim();
  const length = Array.from(normalized).length;
  if (length < 1 || length > maximum) {
    throw argumentError(`${flag} must contain 1..${maximum} characters`);
  }
  return normalized;
}

export function parseRollbackArgs(argv, env = {}) {
  if (!Array.isArray(argv)) throw argumentError("argv must be an array");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof flag !== "string" || !flag.startsWith("--")) {
      throw argumentError("positional arguments are not allowed");
    }
    if (!FLAGS.has(flag)) throw argumentError("unknown flag");
    if (values.has(flag)) throw argumentError(`duplicate flag ${flag}`);
    if (typeof value !== "string" || value.startsWith("--")) {
      throw argumentError(`missing value for ${flag}`);
    }
    values.set(flag, value);
  }

  const required = (flag) => {
    const value = values.get(flag);
    if (value === undefined) throw argumentError(`missing required ${flag}`);
    return value;
  };
  const vendor = required("--vendor").normalize("NFKC").trim();
  if (vendor !== "ss" && vendor !== "sanmar") {
    throw argumentError("unsupported vendor; expected ss or sanmar");
  }
  const expectedCurrentImportId = required("--expected-current-import-id").trim().toLowerCase();
  const toImportId = required("--to-import-id").trim().toLowerCase();
  if (!UUID.test(expectedCurrentImportId)) {
    throw argumentError("--expected-current-import-id must be a UUID");
  }
  if (!UUID.test(toImportId)) throw argumentError("--to-import-id must be a UUID");
  if (expectedCurrentImportId.toLowerCase() === toImportId.toLowerCase()) {
    throw argumentError("current and target import IDs must be different");
  }
  const requestedBy = normalizedText(required("--requested-by"), "--requested-by", 200);
  const reason = normalizedText(required("--reason"), "--reason", 2000);
  const targetUrlValue = values.get("--target-url") ?? env.VENDOR_CATALOG_DATABASE_URL;
  if (typeof targetUrlValue !== "string") throw argumentError("target URL is invalid");
  const targetUrl = targetUrlValue.trim();
  try {
    const parsedTargetUrl = new URL(targetUrl);
    if (
      (parsedTargetUrl.protocol !== "postgres:" && parsedTargetUrl.protocol !== "postgresql:") ||
      parsedTargetUrl.hostname.length === 0 ||
      parsedTargetUrl.pathname.length <= 1
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw argumentError("target URL is invalid");
  }

  const result = { vendor, expectedCurrentImportId, toImportId, requestedBy, reason };
  Object.defineProperty(result, "targetUrl", {
    value: targetUrl,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return result;
}

const STATE_SQL = `
WITH target AS (
  SELECT id, vendor, status, style_count, variant_count,
         source_sync_at, activated_at, imported_at
    FROM catalog_imports
   WHERE id = $3
), live AS (
  SELECT a.import_id, i.status
    FROM active_catalog_versions a
    LEFT JOIN catalog_imports i ON i.id = a.import_id AND i.vendor = a.vendor
   WHERE a.vendor = $1
), style_stats AS (
  SELECT count(*)::bigint AS actual_style_count,
         count(*) FILTER (WHERE source_sync_at IS NULL)::bigint AS null_style_source_sync_at_count,
         bool_or(style_code = $4) AS known_style_present
    FROM catalog_styles
   WHERE import_id = $3
), variant_stats AS (
  SELECT count(*)::bigint AS actual_variant_count,
         count(*) FILTER (WHERE v.source_sync_at IS NULL)::bigint AS null_variant_source_sync_at_count,
         count(*) FILTER (WHERE v.resolved_cost IS NULL OR v.resolved_cost < 0)::bigint AS invalid_resolved_cost_count,
         count(*) FILTER (WHERE s.id IS NULL)::bigint AS orphan_variant_count
    FROM catalog_variants v
    LEFT JOIN catalog_styles s ON s.import_id = v.import_id AND s.id = v.style_id
   WHERE v.import_id = $3
)
SELECT l.import_id AS live_import_id,
       l.status AS live_import_status,
       (t.id IS NOT NULL) AS target_exists,
       t.vendor AS target_vendor,
       t.status AS target_status,
       t.style_count AS stored_style_count,
       t.variant_count AS stored_variant_count,
       ss.actual_style_count,
       vs.actual_variant_count,
       vs.orphan_variant_count,
       vs.invalid_resolved_cost_count,
       ss.null_style_source_sync_at_count,
       vs.null_variant_source_sync_at_count,
       coalesce(ss.known_style_present, false) AS known_style_present,
       t.source_sync_at AS target_source_sync_at,
       t.activated_at AS target_activated_at,
       t.imported_at AS target_imported_at
  FROM (SELECT $2::uuid AS inspected_expected_current_import_id) seed
  LEFT JOIN live l ON true
  LEFT JOIN target t ON true
  CROSS JOIN style_stats ss
  CROSS JOIN variant_stats vs
`;

const JOBS_SQL = `
SELECT status, count(*)::bigint AS status_count
  FROM catalog_ingestion_jobs
 WHERE vendor = $1
   AND status IN ('queued', 'running', 'validating')
 GROUP BY status
 ORDER BY status
 LIMIT 3
`;

function inspectionError() {
  throw new SafeRollbackError("Rollback inspection error: invalid database result");
}

function databaseCount(value, nullable = false) {
  if (value === null && nullable) return null;
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    inspectionError();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  inspectionError();
}

export async function inspectRollbackState(queryable, options) {
  const knownStyle = KNOWN_STYLES[options.vendor];
  if (!knownStyle) throw new SafeRollbackError("Rollback inspection error: unsupported vendor");
  const stateResult = await queryable.query(STATE_SQL, [
    options.vendor,
    options.expectedCurrentImportId,
    options.targetImportId,
    knownStyle,
  ]);
  const jobsResult = await queryable.query(JOBS_SQL, [options.vendor]);
  const row = stateResult.rows?.[0] ?? {};
  const targetExists = row.target_exists === true;
  const jobRows = jobsResult.rows;
  if (!Array.isArray(jobRows) || jobRows.length > 3) inspectionError();
  const seenStatuses = new Set();
  const statuses = jobRows
    .map((job) => {
      if (
        (job.status !== "queued" && job.status !== "running" && job.status !== "validating") ||
        seenStatuses.has(job.status)
      ) {
        inspectionError();
      }
      seenStatuses.add(job.status);
      return { status: job.status, count: databaseCount(job.status_count) };
    })
    .sort((left, right) => left.status.localeCompare(right.status));
  let nonTerminalJobCount = 0;
  for (const status of statuses) {
    if (!Number.isSafeInteger(nonTerminalJobCount + status.count)) inspectionError();
    nonTerminalJobCount += status.count;
  }

  return {
    vendor: options.vendor,
    expectedCurrentImportId: options.expectedCurrentImportId,
    targetImportId: options.targetImportId,
    live: {
      importId: row.live_import_id ?? null,
      status: row.live_import_status ?? null,
    },
    target: {
      exists: targetExists,
      vendor: row.target_vendor ?? null,
      status: row.target_status ?? null,
      actualStyleCount: databaseCount(row.actual_style_count),
      actualVariantCount: databaseCount(row.actual_variant_count),
      storedStyleCount: databaseCount(row.stored_style_count, !targetExists),
      storedVariantCount: databaseCount(row.stored_variant_count, !targetExists),
      orphanVariantCount: databaseCount(row.orphan_variant_count),
      invalidResolvedCostCount: databaseCount(row.invalid_resolved_cost_count),
      nullStyleSourceSyncAtCount: databaseCount(row.null_style_source_sync_at_count),
      nullVariantSourceSyncAtCount: databaseCount(row.null_variant_source_sync_at_count),
      knownStylePresent: row.known_style_present === true,
      sourceSyncAt: row.target_source_sync_at ?? null,
      activatedAt: row.target_activated_at ?? null,
      importedAt: row.target_imported_at ?? null,
    },
    nonTerminalJobs: {
      count: nonTerminalJobCount,
      statuses,
    },
  };
}

function safetyError(message) {
  throw new SafeRollbackError(`Rollback preflight failed: ${message}`);
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

const JOB_STATUSES = new Set(["queued", "running", "validating"]);

function normalizedStateVendor(value) {
  if (typeof value !== "string") safetyError("rollback identity is invalid");
  const vendor = value.normalize("NFKC").trim();
  if (vendor !== "ss" && vendor !== "sanmar") safetyError("rollback identity is invalid");
  return vendor;
}

function normalizedStateUuid(value) {
  if (typeof value !== "string") safetyError("rollback identity is invalid");
  const id = value.trim().toLowerCase();
  if (!UUID.test(id)) safetyError("rollback identity is invalid");
  return id;
}

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizedTimestamp(value, nullable) {
  if (value === null && nullable) return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) safetyError("target timestamp is invalid");
    return value.toISOString();
  }
  if (typeof value !== "string") safetyError("target timestamp is invalid");
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) safetyError("target timestamp is invalid");
  const [, year, month, day, hour, minute, second] = match;
  const calendarDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    calendarDate.getUTCFullYear() !== Number(year) ||
    calendarDate.getUTCMonth() + 1 !== Number(month) ||
    calendarDate.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    safetyError("target timestamp is invalid");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) safetyError("target timestamp is invalid");
  return parsed.toISOString();
}

export function assertRollbackStateSafe(state) {
  const live = state?.live;
  const target = state?.target;
  const jobs = state?.nonTerminalJobs;
  if (!live?.importId) safetyError("no active catalog version exists");
  const vendor = normalizedStateVendor(state.vendor);
  const expectedCurrentImportId = normalizedStateUuid(state.expectedCurrentImportId);
  const targetImportId = normalizedStateUuid(state.targetImportId);
  const liveImportId = normalizedStateUuid(live.importId);
  if (liveImportId !== expectedCurrentImportId) safetyError("current catalog pointer mismatch");
  if (live.status !== "active") safetyError("current import is not active");
  if (target?.exists !== true) safetyError("target import was not found");
  if (target.vendor !== vendor) safetyError("target import vendor does not match");
  if (target.status !== "superseded") safetyError("target import is not superseded");
  if (expectedCurrentImportId === targetImportId) safetyError("current and target import IDs must be different");
  if (!validCount(jobs?.count) || !Array.isArray(jobs.statuses) || jobs.statuses.length > 3) {
    safetyError("ingestion job summary is invalid");
  }
  const seenJobStatuses = new Set();
  let jobTotal = 0;
  for (const entry of jobs.statuses) {
    if (
      !entry ||
      !JOB_STATUSES.has(entry.status) ||
      seenJobStatuses.has(entry.status) ||
      !validCount(entry.count) ||
      !Number.isSafeInteger(jobTotal + entry.count)
    ) {
      safetyError("ingestion job summary is invalid");
    }
    seenJobStatuses.add(entry.status);
    jobTotal += entry.count;
  }
  if (jobTotal !== jobs.count) safetyError("ingestion job summary is invalid");
  if (jobTotal > 0) safetyError("an active non-terminal ingestion job exists");

  const countFields = [
    target.actualStyleCount,
    target.actualVariantCount,
    target.storedStyleCount,
    target.storedVariantCount,
    target.orphanVariantCount,
    target.invalidResolvedCostCount,
    target.nullStyleSourceSyncAtCount,
    target.nullVariantSourceSyncAtCount,
  ];
  if (!countFields.every(validCount)) safetyError("target catalog counts are invalid");
  if (target.actualStyleCount !== target.storedStyleCount) safetyError("target style count mismatch");
  if (target.actualVariantCount !== target.storedVariantCount) safetyError("target variant count mismatch");
  if (target.actualStyleCount === 0) safetyError("target catalog has zero styles");
  if (target.actualVariantCount === 0) safetyError("target catalog has zero variants");
  if (target.orphanVariantCount !== 0) safetyError("target catalog contains orphan variants");
  if (target.invalidResolvedCostCount !== 0) safetyError("target catalog contains null or negative resolved costs");
  if (target.nullStyleSourceSyncAtCount !== 0) safetyError("target catalog has null style source timestamps");
  if (target.nullVariantSourceSyncAtCount !== 0) safetyError("target catalog has null variant source timestamps");
  if (target.knownStylePresent !== true) safetyError("target catalog is missing the known style");

  const sourceSyncAt = normalizedTimestamp(target.sourceSyncAt, true);
  const activatedAt = normalizedTimestamp(target.activatedAt, true);
  const importedAt = normalizedTimestamp(target.importedAt, false);

  return {
    vendor,
    expectedCurrentImportId,
    targetImportId,
    live: { importId: liveImportId, status: live.status },
    target: {
      exists: true,
      vendor: target.vendor,
      status: target.status,
      actualStyleCount: target.actualStyleCount,
      actualVariantCount: target.actualVariantCount,
      storedStyleCount: target.storedStyleCount,
      storedVariantCount: target.storedVariantCount,
      orphanVariantCount: target.orphanVariantCount,
      invalidResolvedCostCount: target.invalidResolvedCostCount,
      nullStyleSourceSyncAtCount: target.nullStyleSourceSyncAtCount,
      nullVariantSourceSyncAtCount: target.nullVariantSourceSyncAtCount,
      knownStylePresent: target.knownStylePresent,
      sourceSyncAt,
      activatedAt,
      importedAt,
    },
    nonTerminalJobs: {
      count: jobs.count,
      statuses: jobs.statuses.map(({ status, count }) => ({ status, count })),
    },
  };
}

function transactionError(message) {
  return new SafeRollbackError(`Rollback transaction failed: ${message}`);
}

function normalizedExecutionOptions(options) {
  if (!options || typeof options !== "object") throw transactionError("invalid options");
  let vendor;
  let expectedCurrentImportId;
  let targetImportId;
  try {
    vendor = options.vendor.normalize("NFKC").trim();
    expectedCurrentImportId = options.expectedCurrentImportId.trim().toLowerCase();
    targetImportId = options.targetImportId.trim().toLowerCase();
  } catch {
    throw transactionError("invalid options");
  }
  if ((vendor !== "ss" && vendor !== "sanmar") ||
      !UUID.test(expectedCurrentImportId) || !UUID.test(targetImportId) ||
      expectedCurrentImportId === targetImportId) {
    throw transactionError("invalid options");
  }
  let requestedBy;
  let reason;
  try {
    requestedBy = normalizedText(options.requestedBy, "requestedBy", 200);
    reason = normalizedText(options.reason, "reason", 2000);
  } catch {
    throw transactionError("invalid options");
  }
  const onPhase = options.testHooks?.onPhase;
  if (onPhase !== undefined && typeof onPhase !== "function") {
    throw transactionError("invalid options");
  }
  const lockTimeoutMs = options.testHooks?.lockTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 30_000) {
    throw transactionError("invalid options");
  }
  return {
    vendor,
    expectedCurrentImportId,
    targetImportId,
    requestedBy,
    reason,
    onPhase,
    lockTimeoutMs,
  };
}

function requireOne(result) {
  if (result?.rowCount !== 1) throw transactionError("concurrent catalog change detected");
}

export async function executeCatalogRollback(targetPool, options) {
  const input = normalizedExecutionOptions(options);
  if (!targetPool || typeof targetPool.connect !== "function") {
    throw transactionError("invalid target pool");
  }
  let client;
  try {
    client = await targetPool.connect();
  } catch {
    throw transactionError("connection unavailable");
  }
  let began = false;
  const phase = async (name) => {
    if (input.onPhase) await input.onPhase(name, client);
  };
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SELECT set_config('lock_timeout', $1, true)", [`${input.lockTimeoutMs}ms`]);
    await client.query("SELECT set_config('statement_timeout', $1, true)", ["300000ms"]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `cmp-ingestion-lease:${input.vendor}`,
    ]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `cmp-vendor-catalog:${input.vendor}`,
    ]);
    await phase("afterAdvisoryLock");

    const pointer = await client.query(
      `SELECT import_id FROM active_catalog_versions
        WHERE vendor = $1 FOR UPDATE`,
      [input.vendor]
    );
    if (pointer.rowCount !== 1 || pointer.rows[0]?.import_id !== input.expectedCurrentImportId) {
      safetyError("current catalog pointer mismatch");
    }

    const lockedImports = await client.query(
      `SELECT id, vendor, status FROM catalog_imports
        WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[input.expectedCurrentImportId, input.targetImportId]]
    );
    if (lockedImports.rowCount !== 2) {
      safetyError("target import was not found");
    }

    const safe = assertRollbackStateSafe(await inspectRollbackState(client, input));
    await phase("afterIntegrityCheck");

    await phase("beforeCurrentUpdate");
    requireOne(await client.query(
      `UPDATE catalog_imports SET status = 'superseded'
        WHERE id = $1 AND vendor = $2 AND status = 'active'`,
      [input.expectedCurrentImportId, input.vendor]
    ));
    await phase("beforeTargetUpdate");
    requireOne(await client.query(
      `UPDATE catalog_imports SET status = 'active', activated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND vendor = $2 AND status = 'superseded'`,
      [input.targetImportId, input.vendor]
    ));
    await phase("beforePointerUpdate");
    requireOne(await client.query(
      `UPDATE active_catalog_versions
          SET import_id = $3, activated_at = CURRENT_TIMESTAMP
        WHERE vendor = $1 AND import_id = $2`,
      [input.vendor, input.expectedCurrentImportId, input.targetImportId]
    ));

    const auditId = randomUUID();
    await phase("beforeAuditInsert");
    const audit = await client.query(
      `INSERT INTO catalog_rollbacks
         (id, vendor, from_import_id, to_import_id, requested_by, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING rolled_back_at`,
      [auditId, input.vendor, input.expectedCurrentImportId, input.targetImportId,
       input.requestedBy, input.reason]
    );
    requireOne(audit);
    const rolledBackAt = audit.rows[0]?.rolled_back_at;
    if (!(rolledBackAt instanceof Date) || !Number.isFinite(rolledBackAt.getTime())) {
      throw transactionError("invalid audit result");
    }
    await phase("afterAuditInsert");
    await client.query("COMMIT");
    began = false;
    return {
      rolledBack: true,
      vendor: input.vendor,
      fromImportId: input.expectedCurrentImportId,
      toImportId: input.targetImportId,
      auditId,
      rolledBackAt: rolledBackAt.toISOString(),
      styleCount: safe.target.actualStyleCount,
      variantCount: safe.target.actualVariantCount,
    };
  } catch (error) {
    if (began) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
    }
    if (error instanceof SafeRollbackError) {
      throw error;
    }
    throw transactionError("operation aborted");
  } finally {
    client.release();
  }
}
