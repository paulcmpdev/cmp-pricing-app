"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtCurrency, fmtPercent } from "./pricing-helpers";
import VersionHistoryPanel from "./VersionHistoryPanel";

type ServiceComposition = { sizeKey: string; quantityPerShirt: number };
type AdditionalPrintService = {
  key: string;
  name: string;
  description: string;
  type: "service" | "package";
  geometryKey: string | null;
  composition: ServiceComposition[];
  cogs: number;
  operatorOperatingCost: number;
  enginePrice: number;
  policyFloor: number;
  manualOverride: number | null;
  effectivePrice: number;
  grossMargin: number;
  status: string;
  operatorMinPerShirt: number;
  designerMinPerOrder: number;
  active: boolean;
  sortOrder: number;
};

type Column = {
  key: string;
  label: string;
  required: boolean;
  visible: boolean;
  order: number;
};

type AdditionalPrintsConfig = {
  services: AdditionalPrintService[];
  columns: Column[];
  minimumBillableQuantity: number;
};

type VersionMeta = {
  id: string;
  createdBy: string;
  createdAt: string;
  activatedAt: string | null;
} | null;

type Props = {
  persistenceEnabled: boolean;
};

const GEOMETRY_KEYS = [
  "FLAT_LARGE",
  "FLAT_SLEEVE",
  "FLAT_BOTTOM_CHEST",
  "FLAT_VERTICAL",
  "FLAT_NAME",
  "FLAT_NUMBER",
  "FLAT_BASE",
] as const;

// Semantic status treatment: engine-priced rows read as neutral/good, a
// manual override reads as an intentional accent decision, and a strategic
// override that sits below the engine's own price is flagged amber so it's
// never mistaken for a routine override.
function statusBadgeClasses(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("strategic")) {
    return "border-amber-700/40 bg-amber-900/20 text-amber-300";
  }
  if (normalized.includes("manual") || normalized.includes("override")) {
    return "border-cyan-700/40 bg-cyan-900/20 text-cyan-300";
  }
  return "border-emerald-700/40 bg-emerald-900/20 text-emerald-300";
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${statusBadgeClasses(status)}`}
    >
      {status}
    </span>
  );
}

function renderCellValue(service: AdditionalPrintService, colKey: string): React.ReactNode {
  switch (colKey) {
    case "name":
      return (
        <div>
          <div className="font-medium text-neutral-200">{service.name}</div>
          {!service.active && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-neutral-700 text-neutral-400">
              Inactive
            </span>
          )}
        </div>
      );
    case "effectivePrice":
      return <span className="font-mono font-semibold text-neutral-100">{fmtCurrency(service.effectivePrice)}</span>;
    case "description":
      return <span className="text-neutral-400">{service.description}</span>;
    case "type":
      return <span className="text-neutral-400 capitalize">{service.type}</span>;
    case "cogs":
      return <span className="font-mono text-neutral-400">{fmtCurrency(service.cogs)}</span>;
    case "operatorOperatingCost":
      return <span className="font-mono text-neutral-400">{fmtCurrency(service.operatorOperatingCost)}</span>;
    case "enginePrice":
      return <span className="font-mono text-neutral-400">{fmtCurrency(service.enginePrice)}</span>;
    case "policyFloor":
      return <span className="font-mono text-neutral-400">{service.policyFloor > 0 ? fmtCurrency(service.policyFloor) : "—"}</span>;
    case "manualOverride":
      return <span className="font-mono text-neutral-400">{service.manualOverride != null ? fmtCurrency(service.manualOverride) : "—"}</span>;
    case "grossMargin":
      return <span className="font-mono font-semibold text-neutral-200">{fmtPercent(service.grossMargin)}</span>;
    case "status":
      return <StatusBadge status={service.status} />;
    case "operatorMinPerShirt":
      return <span className="font-mono text-neutral-400">{service.operatorMinPerShirt}</span>;
    case "designerMinPerOrder":
      return <span className="font-mono text-neutral-400">{service.designerMinPerOrder}</span>;
    case "geometryKey":
      return <span className="text-neutral-400 font-mono text-[10px]">{service.geometryKey ?? "composite"}</span>;
    default:
      return "—";
  }
}

// Columns already shown on the collapsed mobile card / desktop's implicit
// "always visible" set — the expanded mobile card lists every other
// currently-visible column (including audit-only ones) as label/value pairs.
const MOBILE_SUMMARY_KEYS = new Set(["name", "effectivePrice", "grossMargin"]);

export default function AdditionalPrintsEditor({ persistenceEnabled }: Props) {
  const [config, setConfig] = useState<AdditionalPrintsConfig | null>(null);
  const [originalConfig, setOriginalConfig] = useState<AdditionalPrintsConfig | null>(null);
  const [version, setVersion] = useState<VersionMeta>(null);
  const [source, setSource] = useState<"baseline" | "database">("baseline");
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [rollbackInProgress, setRollbackInProgress] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [isDesktop, setIsDesktop] = useState(true);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setIsDesktop(window.innerWidth >= 1024);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const isDirty = useMemo(() => {
    if (!config || !originalConfig) return false;
    return JSON.stringify(config) !== JSON.stringify(originalConfig);
  }, [config, originalConfig]);

  useEffect(() => {
    dirtyRef.current = isDirty;
  }, [isDirty]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/pricing/config?type=additional_prints");
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      // Defense-in-depth: callers (e.g. the rollback reload) already check
      // dirtyRef before starting this GET, but a draft edit can still land
      // between that check and this line while the request was in flight.
      // Re-check live, right before committing, so a late edit is never
      // silently clobbered.
      if (dirtyRef.current) {
        setError(
          "A background reload finished, but your in-progress draft changes were kept instead of being overwritten."
        );
        return;
      }
      setConfig(data.data);
      setOriginalConfig(data.data);
      setVersion(data.version);
      setSource(data.source);
      setBootstrapRequired(Boolean(data.bootstrapRequired));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // Defense-in-depth: even though rollbackInProgress locks out edit-mode
  // entry and draft mutation for the whole rollback lifecycle, refuse to
  // clobber a dirty draft if one somehow exists when the reload fires.
  const handleRolledBack = useCallback(async () => {
    if (dirtyRef.current) {
      setError(
        "Rollback completed, but your in-progress draft changes were kept instead of being overwritten. Reload to see the rolled-back version."
      );
      return;
    }
    await fetchConfig();
  }, [fetchConfig]);

  const validateConfig = useCallback((c: AdditionalPrintsConfig): string[] => {
    const errors: string[] = [];
    if (c.services.length === 0) errors.push("At least one service is required.");
    const keys = new Set<string>();
    for (const svc of c.services) {
      if (!svc.key.trim()) errors.push("All services must have a key.");
      if (!svc.name.trim()) errors.push(`Service "${svc.key}" must have a name.`);
      if (svc.composition.length === 0) errors.push(`Service "${svc.name}" needs at least one composition entry.`);
      if (keys.has(svc.key)) errors.push(`Duplicate service key: "${svc.key}".`);
      keys.add(svc.key);
    }
    const requiredCols = c.columns.filter((col) => col.required);
    for (const col of requiredCols) {
      if (!col.visible) errors.push(`Required column "${col.label}" cannot be hidden.`);
    }
    return errors;
  }, []);

  useEffect(() => {
    if (config && editing) {
      setValidationErrors(validateConfig(config));
    }
  }, [config, editing, validateConfig]);

  const handleEdit = () => {
    if (rollbackInProgress) return;
    setEditing(true);
    setValidationErrors([]);
  };

  const handleCancel = () => {
    if (isDirty && !window.confirm("Discard unsaved changes?")) return;
    setConfig(originalConfig ? JSON.parse(JSON.stringify(originalConfig)) : null);
    setEditing(false);
    setValidationErrors([]);
    setColumnSettingsOpen(false);
  };

  const handleSave = async () => {
    if (!config || !persistenceEnabled || rollbackInProgress) return;
    const errors = validateConfig(config);
    if (errors.length > 0) {
      setValidationErrors(errors);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/admin/pricing/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          configType: "additional_prints",
          data: config,
          expectedVersion: version?.id ?? null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setVersion(data.version);
      setSource("database");
      setBootstrapRequired(false);
      setOriginalConfig(JSON.parse(JSON.stringify(config)));
      setEditing(false);
      setColumnSettingsOpen(false);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const updateService = (idx: number, field: string, value: unknown) => {
    if (!config || rollbackInProgress) return;
    setConfig({
      ...config,
      services: config.services.map((s, i) =>
        i === idx ? { ...s, [field]: value } : s
      ),
    });
  };

  // Re-numbers services to unique, contiguous sortOrder values (0..n-1) in
  // their current relative order, so gaps left by deletes never collide with
  // newly appended rows.
  const normalizeSortOrder = (services: AdditionalPrintService[]): AdditionalPrintService[] =>
    services
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((s, i) => ({ ...s, sortOrder: i }));

  const addService = () => {
    if (!config || rollbackInProgress) return;
    const existingKeys = new Set(config.services.map((s) => s.key));
    let idx = config.services.length + 1;
    let key = `new_service_${idx}`;
    while (existingKeys.has(key)) key = `new_service_${++idx}`;
    setConfig({
      ...config,
      services: normalizeSortOrder([
        ...config.services,
        {
          key,
          name: "New Service",
          description: "",
          type: "service" as const,
          geometryKey: "FLAT_LARGE",
          composition: [{ sizeKey: "FLAT_LARGE", quantityPerShirt: 1 }],
          cogs: 0,
          operatorOperatingCost: 0,
          enginePrice: 0,
          policyFloor: 0,
          manualOverride: null,
          effectivePrice: 0,
          grossMargin: 0,
          status: "New",
          operatorMinPerShirt: 0,
          designerMinPerOrder: 0,
          active: true,
          sortOrder: config.services.length,
        },
      ]),
    });
  };

  const deleteService = (idx: number) => {
    if (!config || rollbackInProgress) return;
    if (!window.confirm(`Delete service "${config.services[idx].name}"?`)) return;
    setConfig({
      ...config,
      services: normalizeSortOrder(config.services.filter((_, i) => i !== idx)),
    });
  };

  const moveService = (sortedIdx: number, direction: "up" | "down") => {
    if (!config || rollbackInProgress) return;
    const ordered = [...config.services].sort((a, b) => a.sortOrder - b.sortOrder);
    const swapIdx = direction === "up" ? sortedIdx - 1 : sortedIdx + 1;
    if (swapIdx < 0 || swapIdx >= ordered.length) return;
    [ordered[sortedIdx], ordered[swapIdx]] = [ordered[swapIdx], ordered[sortedIdx]];
    setConfig({ ...config, services: ordered.map((s, i) => ({ ...s, sortOrder: i })) });
  };

  const toggleColumnVisibility = (colKey: string) => {
    if (!config || rollbackInProgress) return;
    setConfig({
      ...config,
      columns: config.columns.map((c) =>
        c.key === colKey && !c.required ? { ...c, visible: !c.visible } : c
      ),
    });
  };

  const moveColumn = (colIdx: number, direction: "up" | "down") => {
    if (!config || rollbackInProgress) return;
    const cols = [...config.columns].sort((a, b) => a.order - b.order);
    const swapIdx = direction === "up" ? colIdx - 1 : colIdx + 1;
    if (swapIdx < 0 || swapIdx >= cols.length) return;
    const tmpOrder = cols[colIdx].order;
    cols[colIdx] = { ...cols[colIdx], order: cols[swapIdx].order };
    cols[swapIdx] = { ...cols[swapIdx], order: tmpOrder };
    setConfig({ ...config, columns: cols });
  };

  const visibleColumns = useMemo(
    () => config?.columns.filter((c) => c.visible).sort((a, b) => a.order - b.order) ?? [],
    [config]
  );

  // Mobile expanded-card detail rows: every currently-visible column except
  // the ones already summarized on the collapsed card face.
  const detailColumns = useMemo(
    () => visibleColumns.filter((c) => !MOBILE_SUMMARY_KEYS.has(c.key)),
    [visibleColumns]
  );

  if (loading && !config) {
    return (
      <div className="text-center py-8 text-sm text-neutral-400">
        Loading Additional Prints...
      </div>
    );
  }

  if (error && !config) {
    return (
      <div className="rounded-md bg-red-900/30 border border-red-700 p-4 text-sm text-red-300" role="alert">
        {error}
      </div>
    );
  }

  if (!config) return null;

  const sortedColumns = [...config.columns].sort((a, b) => a.order - b.order);
  const sortedServices = config.services.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const activeCount = config.services.filter((s) => s.active).length;
  const isDirtyDraft = editing && isDirty;

  const editableCell = (
    service: AdditionalPrintService,
    realIdx: number,
    colKey: string,
    opts?: { mobile?: boolean }
  ) => {
    const mobile = opts?.mobile ?? false;
    switch (colKey) {
      case "name":
        return (
          <input
            value={service.name}
            onChange={(e) => updateService(realIdx, "name", e.target.value)}
            aria-label={`Name for ${service.key}`}
            className={
              mobile
                ? "w-full min-h-[40px] text-sm bg-neutral-800 border border-neutral-600 rounded px-3 py-2 text-neutral-200"
                : "w-full text-xs bg-neutral-800 border border-neutral-600 rounded px-1.5 py-0.5 text-neutral-200"
            }
          />
        );
      case "description":
        return (
          <input
            value={service.description}
            onChange={(e) => updateService(realIdx, "description", e.target.value)}
            aria-label={`Description for ${service.key}`}
            className={
              mobile
                ? "w-full min-h-[40px] text-sm bg-neutral-800 border border-neutral-600 rounded px-3 py-2 text-neutral-200"
                : "w-full text-xs bg-neutral-800 border border-neutral-600 rounded px-1.5 py-0.5 text-neutral-200"
            }
          />
        );
      case "type":
        return (
          <select
            value={service.type}
            onChange={(e) => updateService(realIdx, "type", e.target.value)}
            aria-label={`Type for ${service.key}`}
            className="text-[10px] bg-neutral-800 border border-neutral-600 rounded px-1 py-0.5 text-neutral-200"
          >
            <option value="service">service</option>
            <option value="package">package</option>
          </select>
        );
      case "effectivePrice":
        return (
          <input
            type="number"
            value={service.effectivePrice}
            onChange={(e) =>
              updateService(realIdx, "effectivePrice", parseFloat(e.target.value) || 0)
            }
            step="0.05"
            min="0"
            aria-label={`Decoration Price for ${service.key}`}
            className={
              mobile
                ? "w-full min-h-[40px] text-sm text-right bg-neutral-800 border border-neutral-600 rounded px-3 py-2 text-neutral-200"
                : "w-16 text-xs text-right bg-neutral-800 border border-neutral-600 rounded px-1.5 py-0.5 text-neutral-200"
            }
          />
        );
      case "policyFloor":
        return (
          <input
            type="number"
            value={service.policyFloor}
            onChange={(e) =>
              updateService(realIdx, "policyFloor", parseFloat(e.target.value) || 0)
            }
            step="1"
            min="0"
            aria-label={`Policy floor for ${service.key}`}
            className="w-14 text-xs text-right bg-neutral-800 border border-neutral-600 rounded px-1.5 py-0.5 text-neutral-200"
          />
        );
      case "manualOverride":
        return (
          <input
            type="number"
            value={service.manualOverride ?? ""}
            onChange={(e) =>
              updateService(
                realIdx,
                "manualOverride",
                e.target.value === "" ? null : parseFloat(e.target.value) || 0
              )
            }
            step="1"
            min="0"
            placeholder="—"
            aria-label={`Manual override for ${service.key}`}
            className="w-14 text-xs text-right bg-neutral-800 border border-neutral-600 rounded px-1.5 py-0.5 text-neutral-200 placeholder:text-neutral-600"
          />
        );
      case "operatorMinPerShirt":
        return (
          <input
            type="number"
            value={service.operatorMinPerShirt}
            onChange={(e) =>
              updateService(realIdx, "operatorMinPerShirt", parseFloat(e.target.value) || 0)
            }
            min="0"
            aria-label={`Operator minutes per shirt for ${service.key}`}
            className="w-12 text-xs text-right bg-neutral-800 border border-neutral-600 rounded px-1.5 py-0.5 text-neutral-200"
          />
        );
      case "designerMinPerOrder":
        return (
          <input
            type="number"
            value={service.designerMinPerOrder}
            onChange={(e) =>
              updateService(realIdx, "designerMinPerOrder", parseFloat(e.target.value) || 0)
            }
            min="0"
            aria-label={`Designer minutes per order for ${service.key}`}
            className="w-12 text-xs text-right bg-neutral-800 border border-neutral-600 rounded px-1.5 py-0.5 text-neutral-200"
          />
        );
      case "geometryKey":
        return (
          <select
            value={service.geometryKey ?? ""}
            onChange={(e) => updateService(realIdx, "geometryKey", e.target.value || null)}
            aria-label={`Geometry for ${service.key}`}
            className="text-[10px] bg-neutral-800 border border-neutral-600 rounded px-1 py-0.5 text-neutral-200"
          >
            <option value="">composite</option>
            {GEOMETRY_KEYS.map((gk) => (
              <option key={gk} value={gk}>
                {gk}
              </option>
            ))}
          </select>
        );
      default:
        return renderCellValue(service, colKey);
    }
  };

  const mobileServiceRowActions = (service: AdditionalPrintService, sortedIdx: number, realIdx: number) => (
    <div className="flex items-center justify-between gap-2 pt-1">
      <div className="flex items-center gap-2">
        <button
          onClick={() => moveService(sortedIdx, "up")}
          disabled={sortedIdx === 0}
          aria-label={`Move ${service.name} up`}
          className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded border border-neutral-700 bg-neutral-800 text-neutral-300 text-base disabled:opacity-30"
        >
          ↑
        </button>
        <button
          onClick={() => moveService(sortedIdx, "down")}
          disabled={sortedIdx === sortedServices.length - 1}
          aria-label={`Move ${service.name} down`}
          className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded border border-neutral-700 bg-neutral-800 text-neutral-300 text-base disabled:opacity-30"
        >
          ↓
        </button>
        <label className="min-h-[40px] flex items-center gap-1.5 px-2 rounded border border-neutral-700 bg-neutral-800 text-xs text-neutral-300">
          <input
            type="checkbox"
            checked={service.active}
            onChange={(e) => updateService(realIdx, "active", e.target.checked)}
            aria-label={`Set ${service.name} active`}
            className="h-4 w-4"
          />
          Active
        </label>
      </div>
      <button
        onClick={() => deleteService(realIdx)}
        aria-label={`Delete ${service.name}`}
        className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded border border-red-900/40 bg-red-950/30 text-red-400 text-base"
      >
        ×
      </button>
    </div>
  );

  const serviceRowActions = (service: AdditionalPrintService, sortedIdx: number, realIdx: number) => (
    <div className="flex items-center gap-1">
      <button
        onClick={() => moveService(sortedIdx, "up")}
        disabled={sortedIdx === 0}
        className="text-neutral-500 hover:text-neutral-300 disabled:opacity-30 text-[10px]"
        aria-label={`Move ${service.name} up`}
      >
        ↑
      </button>
      <button
        onClick={() => moveService(sortedIdx, "down")}
        disabled={sortedIdx === sortedServices.length - 1}
        className="text-neutral-500 hover:text-neutral-300 disabled:opacity-30 text-[10px]"
        aria-label={`Move ${service.name} down`}
      >
        ↓
      </button>
      <label className="text-[9px] text-neutral-500">
        <input
          type="checkbox"
          checked={service.active}
          onChange={(e) => updateService(realIdx, "active", e.target.checked)}
          aria-label={`Set ${service.name} active`}
          className="mr-0.5"
        />
        Act
      </label>
      <button
        onClick={() => deleteService(realIdx)}
        className="text-red-400 hover:text-red-300 text-[10px]"
        aria-label={`Delete ${service.name}`}
      >
        ×
      </button>
    </div>
  );

  return (
    <div className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-950">
      {/* Toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-3 border-b border-neutral-800 px-4 pt-4 pb-3">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-200" id="ap-matrix-heading">
            Additional Prints / DTF Flat Fees
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded border border-cyan-700/40 bg-cyan-900/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cyan-300">
              {source === "database" ? "Database" : "Baseline"}
              {version && ` · v${version.id.slice(0, 8)}`}
            </span>
            {!persistenceEnabled ? (
              <span className="inline-flex items-center gap-1 rounded border border-amber-700/40 bg-amber-900/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                Preview Only
              </span>
            ) : (
              <span
                className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  isDirtyDraft
                    ? "border-amber-700/40 bg-amber-900/20 text-amber-300"
                    : "border-neutral-700 bg-neutral-800 text-neutral-400"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${isDirtyDraft ? "bg-amber-400" : "bg-emerald-400"}`} />
                {isDirtyDraft ? "Draft · unsaved edits" : editing ? "Editing · no changes yet" : "Preview · unedited"}
              </span>
            )}
            <span className="inline-flex items-center rounded border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
              {activeCount} active services
            </span>
            <span className="inline-flex items-center rounded border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
              Min billable qty {config.minimumBillableQuantity}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <VersionHistoryPanel
            configType="additional_prints"
            currentVersionId={version?.id ?? null}
            persistenceEnabled={persistenceEnabled}
            onRolledBack={handleRolledBack}
            isDraftDirty={editing && isDirty}
            onRollbackStateChange={setRollbackInProgress}
          />
          {!editing ? (
            <button
              onClick={handleEdit}
              disabled={rollbackInProgress}
              title={rollbackInProgress ? "Rollback in progress — please wait" : undefined}
              className="text-xs px-3 py-1.5 rounded bg-neutral-800 border border-neutral-700 text-neutral-200 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Edit Matrix
            </button>
          ) : (
            <>
              <button
                onClick={() => setColumnSettingsOpen(!columnSettingsOpen)}
                className="text-[10px] px-2 py-1 rounded bg-neutral-800 border border-neutral-700 text-neutral-300 hover:bg-neutral-700"
              >
                Columns
              </button>
              <button
                onClick={handleCancel}
                className="text-xs px-3 py-1.5 rounded bg-neutral-800 border border-neutral-700 text-neutral-300 hover:bg-neutral-700"
              >
                Cancel
              </button>
              {persistenceEnabled ? (
                <button
                  onClick={handleSave}
                  disabled={saving || validationErrors.length > 0 || !isDirty}
                  className="text-xs px-3 py-1.5 rounded bg-cyan-700 text-white hover:bg-cyan-600 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {saving ? "Saving..." : "Save Changes"}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="px-4 pb-4 space-y-4">

      {!persistenceEnabled && !editing && (
        <div className="rounded-md bg-amber-900/20 border border-amber-700/40 px-3 py-2 text-xs text-amber-300">
          <strong>Preview Only</strong> — Persistence is disabled. Changes cannot be saved.
        </div>
      )}

      {persistenceEnabled && bootstrapRequired && (
        <div className="rounded-md bg-cyan-900/20 border border-cyan-700/40 px-3 py-2 text-xs text-cyan-300">
          <strong>No active configuration yet.</strong> Showing baseline defaults — click Edit
          Matrix and Save to activate the first version.
        </div>
      )}

      {error && (
        <div className="rounded-md bg-red-900/30 border border-red-700 p-3 text-xs text-red-300" role="alert">
          {error}
        </div>
      )}

      {validationErrors.length > 0 && editing && (
        <div className="rounded-md bg-red-900/30 border border-red-700 p-3 text-xs text-red-300" role="alert">
          <strong>Validation errors:</strong>
          <ul className="mt-1 list-disc list-inside">
            {validationErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Column settings panel */}
      {editing && columnSettingsOpen && (
        <div className="rounded-md bg-neutral-900/60 border border-neutral-800 p-3 space-y-2">
          <h3 className="text-xs font-medium text-neutral-300 mb-2">Column Visibility & Order</h3>
          <div className="space-y-1">
            {sortedColumns.map((col, idx) => (
              <div
                key={col.key}
                className={`flex items-center gap-2 text-[10px] ${col.required ? "text-neutral-500" : "text-neutral-300"}`}
              >
                <input
                  type="checkbox"
                  checked={col.visible}
                  onChange={() => toggleColumnVisibility(col.key)}
                  disabled={col.required}
                  aria-label={`Toggle ${col.label} column`}
                  className="rounded"
                />
                <span className="flex-1">
                  {col.label}
                  {col.required && <span className="text-neutral-600 ml-1">(req)</span>}
                </span>
                <button
                  onClick={() => moveColumn(idx, "up")}
                  disabled={idx === 0}
                  className="text-neutral-500 hover:text-neutral-300 disabled:opacity-30"
                  aria-label={`Move ${col.label} up`}
                >
                  ↑
                </button>
                <button
                  onClick={() => moveColumn(idx, "down")}
                  disabled={idx === sortedColumns.length - 1}
                  className="text-neutral-500 hover:text-neutral-300 disabled:opacity-30"
                  aria-label={`Move ${col.label} down`}
                >
                  ↓
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Desktop full matrix */}
      {isDesktop && (
        <div data-testid="ap-desktop-table-panel" className="overflow-x-auto rounded-md border border-neutral-800">
          <table className="w-full text-xs" aria-labelledby="ap-matrix-heading">
            <thead>
              <tr className="border-b border-neutral-700 bg-neutral-900">
                {visibleColumns.map((col) => (
                  <th
                    key={col.key}
                    className={`py-2 px-2 text-neutral-400 font-medium ${
                      col.key === "name" || col.key === "description"
                        ? "text-left"
                        : "text-right"
                    } ${col.key === "name" ? "sticky left-0 bg-neutral-900 z-10" : ""}`}
                  >
                    {col.label}
                  </th>
                ))}
                {editing && <th className="w-8" />}
              </tr>
            </thead>
            <tbody>
              {sortedServices.map((service, sortedIdx) => {
                const realIdx = config.services.indexOf(service);
                return (
                  <tr
                    key={service.key}
                    className={`border-b border-neutral-800 hover:bg-neutral-800/50 ${
                      !service.active ? "opacity-50" : ""
                    }`}
                  >
                    {visibleColumns.map((col) => (
                      <td
                        key={col.key}
                        className={`py-1.5 px-2 ${
                          col.key === "name" || col.key === "description"
                            ? "text-left"
                            : "text-right"
                        } ${col.key === "name" ? "sticky left-0 bg-neutral-900 z-10" : ""}`}
                      >
                        {editing ? editableCell(service, realIdx, col.key) : renderCellValue(service, col.key)}
                      </td>
                    ))}
                    {editing && (
                      <td className="py-1.5 px-1">{serviceRowActions(service, sortedIdx, realIdx)}</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Mobile / tablet expandable service cards */}
      {!isDesktop && (
        <div data-testid="ap-mobile-card-list" className="space-y-2">
          {sortedServices.map((service, sortedIdx) => {
            const realIdx = config.services.indexOf(service);
            const expanded = expandedKey === service.key;
            return (
              <div
                key={service.key}
                className={`rounded-md border overflow-hidden ${
                  expanded ? "border-cyan-700/40" : "border-neutral-800"
                } ${!service.active ? "opacity-60" : ""}`}
              >
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-label={`Expand ${service.name}`}
                  onClick={() => setExpandedKey(expanded ? null : service.key)}
                  className="w-full min-h-[44px] flex items-center justify-between gap-2 px-3 py-2 text-left bg-neutral-900"
                >
                  <div>
                    <div className="text-sm font-semibold text-neutral-100">{service.name}</div>
                    {!service.active && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-neutral-700 text-neutral-400">
                        Inactive
                      </span>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm font-semibold text-neutral-100">
                      {fmtCurrency(service.effectivePrice)}
                    </div>
                    <div className="text-[10px] text-neutral-500">{fmtPercent(service.grossMargin)} GM</div>
                  </div>
                </button>
                {expanded && (
                  <div className="p-3 space-y-2 border-t border-neutral-800">
                    {editing ? (
                      <>
                        <div className="space-y-1">
                          <span className="text-[10px] uppercase tracking-wide text-neutral-500">Service</span>
                          {editableCell(service, realIdx, "name", { mobile: true })}
                        </div>
                        <div className="space-y-1">
                          <span className="text-[10px] uppercase tracking-wide text-neutral-500">Decoration Price</span>
                          {editableCell(service, realIdx, "effectivePrice", { mobile: true })}
                        </div>
                        <div className="space-y-1">
                          <span className="text-[10px] uppercase tracking-wide text-neutral-500">Description</span>
                          {editableCell(service, realIdx, "description", { mobile: true })}
                        </div>
                      </>
                    ) : null}
                    {detailColumns
                      .filter((col) => !(editing && (col.key === "name" || col.key === "effectivePrice" || col.key === "description")))
                      .map((col) => (
                        <div key={col.key} className="flex items-start justify-between gap-2 text-[11px]">
                          <span className="text-neutral-500">{col.label}</span>
                          <span className="text-right">
                            {editing ? editableCell(service, realIdx, col.key) : renderCellValue(service, col.key)}
                          </span>
                        </div>
                      ))}
                    {editing && mobileServiceRowActions(service, sortedIdx, realIdx)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <button
          onClick={addService}
          className="text-[10px] px-2.5 py-1 rounded bg-neutral-800 border border-neutral-700 text-neutral-300 hover:bg-neutral-700"
        >
          + Add Service
        </button>
      )}

      <div className="text-[10px] text-neutral-500 text-center">
        {config.services.length} services · {activeCount} active ·
        Min billable qty: {config.minimumBillableQuantity}
      </div>
      </div>
    </div>
  );
}
