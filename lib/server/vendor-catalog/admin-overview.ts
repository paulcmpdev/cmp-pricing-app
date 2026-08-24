import "server-only";

type QueryResult = { rows: Record<string, unknown>[] };

export interface AdminOverviewQueryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

export type AdminCatalogVendor = "ss" | "sanmar";
export type AdminCatalogBackend = "postgres" | "sqlite" | "unconfigured";
export type AdminCatalogHealth = "healthy" | "warning" | "unavailable";
export type AdminCatalogJobPhase =
  | "queued"
  | "started"
  | "cloning"
  | "discovered"
  | "patched"
  | "staged"
  | "validating"
  | "completed";

export interface AdminCatalogVendorOverview {
  label: string;
  active: boolean;
  health: AdminCatalogHealth;
  activeImportStatus: string | null;
  styleCount: number;
  variantCount: number;
  sourceStatus: string | null;
  sourceErrors: number;
  sourceSyncAt: string | null;
  importedAt: string | null;
  activatedAt: string | null;
  canaryStyleCode: "3001" | "K500";
  canaryStyleRows: number;
  canaryVariantRows: number;
  activeJobStatus?: string;
}

export interface AdminCatalogRecentJob {
  vendor: AdminCatalogVendor;
  status: string;
  phase: AdminCatalogJobPhase | null;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AdminCatalogRollbackSummary {
  totalCount: number;
  latestAt: string | null;
}

export interface AdminCatalogOverview {
  available: boolean;
  backend: AdminCatalogBackend;
  generatedAt: string;
  reason?: string;
  vendors: Record<AdminCatalogVendor, AdminCatalogVendorOverview>;
  recentJobs: AdminCatalogRecentJob[];
  rollbackSummary: Record<AdminCatalogVendor, AdminCatalogRollbackSummary>;
  totals: {
    styleCount: number;
    variantCount: number;
    healthyVendorCount: number;
  };
}

const VENDOR_DEFS = {
  ss: { label: "S&S Activewear", canaryStyleCode: "3001" },
  sanmar: { label: "SanMar", canaryStyleCode: "K500" },
} as const;

const NONTERMINAL_JOB_STATUSES = ["queued", "running", "validating"] as const;
const GENERIC_UNAVAILABLE_REASON = "The vendor catalog overview is unavailable.";

export function unavailableAdminCatalogOverview(
  backend: AdminCatalogBackend,
  generatedAt: Date = new Date()
): AdminCatalogOverview {
  return {
    available: false,
    backend,
    generatedAt: requiredTimestamp(generatedAt),
    reason: GENERIC_UNAVAILABLE_REASON,
    vendors: {
      ss: emptyVendor("ss"),
      sanmar: emptyVendor("sanmar"),
    },
    recentJobs: [],
    rollbackSummary: {
      ss: { totalCount: 0, latestAt: null },
      sanmar: { totalCount: 0, latestAt: null },
    },
    totals: { styleCount: 0, variantCount: 0, healthyVendorCount: 0 },
  };
}

export async function queryAdminCatalogOverview(
  database: AdminOverviewQueryable,
  generatedAt: Date = new Date()
): Promise<AdminCatalogOverview> {
  const [vendorResult, jobsResult, rollbackResult] = await Promise.all([
    database.query(
      `WITH vendor_canaries(vendor, label, canary_style_code) AS (
         VALUES
           ('ss', 'S&S Activewear', '3001'),
           ('sanmar', 'SanMar', 'K500')
       ),
       active_imports AS (
         SELECT vc.vendor, i.id AS import_id, i.status, i.style_count,
                i.variant_count, i.source_status, i.source_errors,
                i.source_sync_at, i.imported_at, i.activated_at
         FROM vendor_canaries vc
         LEFT JOIN active_catalog_versions a
           ON a.vendor = vc.vendor
         LEFT JOIN catalog_imports i
           ON i.id = a.import_id
          AND i.vendor = vc.vendor
          AND i.status = 'active'
       )
       SELECT vc.vendor,
              (ai.import_id IS NOT NULL) AS active,
              ai.status AS active_import_status,
              ai.style_count,
              ai.variant_count,
              ai.source_status,
              ai.source_errors,
              ai.source_sync_at,
              ai.imported_at,
              ai.activated_at,
              (
                SELECT count(*)::int
                FROM catalog_styles s
                WHERE s.import_id = ai.import_id
                  AND s.vendor = vc.vendor
                  AND s.style_code = vc.canary_style_code
              ) AS canary_style_rows,
              (
                SELECT count(*)::int
                FROM catalog_variants v
                JOIN catalog_styles cs
                  ON cs.import_id = v.import_id
                 AND cs.id = v.style_id
                WHERE cs.import_id = ai.import_id
                  AND cs.vendor = vc.vendor
                  AND cs.style_code = vc.canary_style_code
                  AND v.import_id = ai.import_id
                  AND v.style_id = cs.id
              ) AS canary_variant_rows,
              active_job.status AS active_job_status
       FROM vendor_canaries vc
       LEFT JOIN active_imports ai
         ON ai.vendor = vc.vendor
       LEFT JOIN LATERAL (
         SELECT status
         FROM catalog_ingestion_jobs j
         WHERE j.vendor = vc.vendor
           AND j.status = ANY($1::text[])
         ORDER BY created_at DESC
         LIMIT 1
       ) active_job ON true
       ORDER BY vc.vendor`,
      [[...NONTERMINAL_JOB_STATUSES]]
    ),
    database.query(
      `SELECT vendor,
              status,
              CASE checkpoint->>'phase'
                WHEN 'queued' THEN 'queued'
                WHEN 'started' THEN 'started'
                WHEN 'cloning' THEN 'cloning'
                WHEN 'discovered' THEN 'discovered'
                WHEN 'patched' THEN 'patched'
                WHEN 'staged' THEN 'staged'
                WHEN 'validating' THEN 'validating'
                WHEN 'completed' THEN 'completed'
                ELSE NULL
              END AS phase,
              attempts,
              created_at,
              started_at,
              completed_at
       FROM catalog_ingestion_jobs
       ORDER BY created_at DESC
       LIMIT 8`
    ),
    database.query(
      `WITH vendors(vendor) AS (VALUES ('ss'), ('sanmar'))
       SELECT v.vendor,
              count(r.vendor)::int AS total_count,
              max(r.rolled_back_at) AS latest_at
       FROM vendors v
       LEFT JOIN catalog_rollbacks r
         ON r.vendor = v.vendor
       GROUP BY v.vendor
       ORDER BY v.vendor`
    ),
  ]);

  const vendors = mapVendorRows(vendorResult.rows);
  const recentJobs = jobsResult.rows.map(mapRecentJob);
  const rollbackSummary = mapRollbackRows(rollbackResult.rows);
  const healthyVendorCount = vendorList().filter(
    (vendor) => vendors[vendor].health === "healthy"
  ).length;

  return {
    available: true,
    backend: "postgres",
    generatedAt: requiredTimestamp(generatedAt),
    vendors,
    recentJobs,
    rollbackSummary,
    totals: {
      styleCount: vendors.ss.styleCount + vendors.sanmar.styleCount,
      variantCount: vendors.ss.variantCount + vendors.sanmar.variantCount,
      healthyVendorCount,
    },
  };
}

function mapVendorRows(
  rows: Record<string, unknown>[]
): Record<AdminCatalogVendor, AdminCatalogVendorOverview> {
  const vendors = {
    ss: emptyVendor("ss"),
    sanmar: emptyVendor("sanmar"),
  };

  for (const row of rows) {
    const vendor = asVendor(row.vendor);
    const active = Boolean(row.active);
    const styleCount = active ? count(row.style_count) : 0;
    const variantCount = active ? count(row.variant_count) : 0;
    const sourceErrors = active ? count(row.source_errors) : 0;
    const canaryStyleRows = count(row.canary_style_rows);
    const canaryVariantRows = count(row.canary_variant_rows);
    const activeJobStatus = nullableString(row.active_job_status);
    const health = healthFor({
      active,
      styleCount,
      variantCount,
      sourceErrors,
      canaryStyleRows,
      canaryVariantRows,
      activeJobStatus,
    });

    vendors[vendor] = {
      label: VENDOR_DEFS[vendor].label,
      active,
      health,
      activeImportStatus: nullableString(row.active_import_status),
      styleCount,
      variantCount,
      sourceStatus: nullableString(row.source_status),
      sourceErrors,
      sourceSyncAt: timestamp(row.source_sync_at),
      importedAt: timestamp(row.imported_at),
      activatedAt: timestamp(row.activated_at),
      canaryStyleCode: VENDOR_DEFS[vendor].canaryStyleCode,
      canaryStyleRows,
      canaryVariantRows,
      ...(activeJobStatus == null ? {} : { activeJobStatus }),
    };
  }

  return vendors;
}

function healthFor({
  active,
  styleCount,
  variantCount,
  sourceErrors,
  canaryStyleRows,
  canaryVariantRows,
  activeJobStatus,
}: {
  active: boolean;
  styleCount: number;
  variantCount: number;
  sourceErrors: number;
  canaryStyleRows: number;
  canaryVariantRows: number;
  activeJobStatus: string | null;
}): AdminCatalogHealth {
  if (!active) return "unavailable";
  if (
    styleCount > 0 &&
    variantCount > 0 &&
    sourceErrors === 0 &&
    canaryStyleRows > 0 &&
    canaryVariantRows > 0 &&
    activeJobStatus == null
  ) {
    return "healthy";
  }
  return "warning";
}

function mapRecentJob(row: Record<string, unknown>): AdminCatalogRecentJob {
  return {
    vendor: asVendor(row.vendor),
    status: String(row.status),
    phase: asPhase(row.phase),
    attempts: count(row.attempts),
    createdAt: requiredTimestamp(row.created_at),
    startedAt: timestamp(row.started_at),
    completedAt: timestamp(row.completed_at),
  };
}

function mapRollbackRows(
  rows: Record<string, unknown>[]
): Record<AdminCatalogVendor, AdminCatalogRollbackSummary> {
  const summary: Record<AdminCatalogVendor, AdminCatalogRollbackSummary> = {
    ss: { totalCount: 0, latestAt: null },
    sanmar: { totalCount: 0, latestAt: null },
  };

  for (const row of rows) {
    const vendor = asVendor(row.vendor);
    summary[vendor] = {
      totalCount: count(row.total_count),
      latestAt: timestamp(row.latest_at),
    };
  }

  return summary;
}

function emptyVendor(vendor: AdminCatalogVendor): AdminCatalogVendorOverview {
  return {
    label: VENDOR_DEFS[vendor].label,
    active: false,
    health: "unavailable",
    activeImportStatus: null,
    styleCount: 0,
    variantCount: 0,
    sourceStatus: null,
    sourceErrors: 0,
    sourceSyncAt: null,
    importedAt: null,
    activatedAt: null,
    canaryStyleCode: VENDOR_DEFS[vendor].canaryStyleCode,
    canaryStyleRows: 0,
    canaryVariantRows: 0,
  };
}

function vendorList(): AdminCatalogVendor[] {
  return ["ss", "sanmar"];
}

function asVendor(value: unknown): AdminCatalogVendor {
  if (value === "ss" || value === "sanmar") return value;
  throw new Error(`Unexpected vendor value: ${String(value)}`);
}

function asPhase(value: unknown): AdminCatalogJobPhase | null {
  if (
    value === "queued" ||
    value === "started" ||
    value === "cloning" ||
    value === "discovered" ||
    value === "patched" ||
    value === "staged" ||
    value === "validating" ||
    value === "completed"
  ) {
    return value;
  }
  return null;
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function count(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("Invalid catalog count.");
  }
  return parsed;
}

function requiredTimestamp(value: unknown): string {
  const parsed = timestamp(value);
  if (parsed == null) throw new Error("Invalid catalog timestamp.");
  return parsed;
}

function timestamp(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("Invalid catalog timestamp.");
  return date.toISOString();
}
