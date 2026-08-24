export type Vendor = "ss" | "sanmar";

export function safeRollbackErrorMessage(error: unknown): string | null;

export interface RollbackArgs {
  vendor: Vendor;
  expectedCurrentImportId: string;
  toImportId: string;
  requestedBy: string;
  reason: string;
  readonly targetUrl: string;
}

export interface Queryable {
  query(sql: string, params?: readonly unknown[]): Promise<{
    rows: Record<string, unknown>[];
    rowCount?: number | null;
  }>;
}

export interface RollbackInspectionOptions {
  vendor: Vendor;
  expectedCurrentImportId: string;
  targetImportId: string;
}

export type RollbackTestHookPhase =
  | "afterAdvisoryLock"
  | "afterIntegrityCheck"
  | "beforeCurrentUpdate"
  | "beforeTargetUpdate"
  | "beforePointerUpdate"
  | "beforeAuditInsert"
  | "afterAuditInsert";

export interface TransactionClient extends Queryable {
  release(): void;
}

export interface RollbackTargetPool {
  connect(): Promise<TransactionClient>;
}

export interface ExecuteCatalogRollbackOptions extends RollbackInspectionOptions {
  requestedBy: string;
  reason: string;
  /** Narrow failure/concurrency injection seam for integration tests; not for CLI use. */
  testHooks?: {
    onPhase?(phase: RollbackTestHookPhase, client: TransactionClient): Promise<void> | void;
    /** Test-only shorter advisory lock wait; production default is 30 seconds. */
    lockTimeoutMs?: number;
  };
}

export interface CatalogRollbackResult {
  rolledBack: true;
  vendor: Vendor;
  fromImportId: string;
  toImportId: string;
  auditId: string;
  rolledBackAt: string;
  styleCount: number;
  variantCount: number;
}

export interface RollbackState {
  vendor: Vendor;
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
    sanmarCasePriceInvariantViolationCount?: number;
    nullStyleSourceSyncAtCount: number;
    nullVariantSourceSyncAtCount: number;
    knownStylePresent: boolean;
    sourceSyncAt: unknown | null;
    activatedAt: unknown | null;
    importedAt: unknown | null;
  };
  nonTerminalJobs: {
    count: number;
    statuses: Array<{ status: string; count: number }>;
  };
}

export interface ValidatedRollbackState extends Omit<RollbackState, "target"> {
  target: Omit<
    RollbackState["target"],
    "sourceSyncAt" | "activatedAt" | "importedAt"
  > & {
    sourceSyncAt: string | null;
    activatedAt: string | null;
    importedAt: string;
  };
}

export function parseRollbackArgs(
  argv: string[],
  env?: Record<string, string | undefined>
): RollbackArgs;
export function inspectRollbackState(
  queryable: Queryable,
  options: RollbackInspectionOptions
): Promise<RollbackState>;
export function assertRollbackStateSafe(state: RollbackState): ValidatedRollbackState;
export function executeCatalogRollback(
  targetPool: RollbackTargetPool,
  options: ExecuteCatalogRollbackOptions
): Promise<CatalogRollbackResult>;
