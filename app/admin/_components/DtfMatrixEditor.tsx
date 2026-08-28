"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtCurrency } from "./pricing-helpers";
import VersionHistoryPanel from "./VersionHistoryPanel";

type DtfLane = { key: string; label: string; margin: number; active: boolean };
type DtfTier = {
  tier: string;
  minQty: number;
  maxQty: number | null;
  prices: Record<string, number>;
};
type DtfMatrixConfig = { lanes: DtfLane[]; tiers: DtfTier[] };

type VersionMeta = {
  id: string;
  createdBy: string;
  createdAt: string;
  activatedAt: string | null;
} | null;

type Props = {
  persistenceEnabled: boolean;
};

function formatQtyRange(min: number, max: number | null): string {
  if (max === null) return `${min.toLocaleString()}+`;
  if (min === max) return String(min);
  return `${min.toLocaleString()}-${max.toLocaleString()}`;
}

export default function DtfMatrixEditor({ persistenceEnabled }: Props) {
  const [config, setConfig] = useState<DtfMatrixConfig | null>(null);
  const [originalConfig, setOriginalConfig] = useState<DtfMatrixConfig | null>(null);
  const [version, setVersion] = useState<VersionMeta>(null);
  const [source, setSource] = useState<"baseline" | "database">("baseline");
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [rollbackInProgress, setRollbackInProgress] = useState(false);
  const dirtyRef = useRef(false);

  const isDirty = useMemo(() => {
    if (!config || !originalConfig) return false;
    return JSON.stringify(config) !== JSON.stringify(originalConfig);
  }, [config, originalConfig]);

  useEffect(() => {
    dirtyRef.current = isDirty;
  }, [isDirty]);

  // Beforeunload warning
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
      const res = await fetch("/api/admin/pricing/config?type=dtf_matrix");
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

  const validateConfig = useCallback((c: DtfMatrixConfig): string[] => {
    const errors: string[] = [];
    if (c.lanes.length === 0) errors.push("At least one pricing lane is required.");
    if (c.tiers.length === 0) errors.push("At least one quantity tier is required.");
    if (c.tiers.length > 0 && c.tiers[0].minQty !== 1) {
      errors.push("First tier must start at quantity 1.");
    }
    const activeLanes = c.lanes.filter((l) => l.active);
    if (activeLanes.length === 0) errors.push("At least one lane must be active.");

    for (let i = 0; i < c.tiers.length; i++) {
      const t = c.tiers[i];
      const isLast = i === c.tiers.length - 1;

      // Only the final tier may be open-ended
      if (t.maxQty === null && !isLast) {
        errors.push(`Tier "${t.tier}": only the final tier may be open-ended.`);
      }

      if (t.maxQty !== null && t.maxQty < t.minQty) {
        errors.push(`Tier "${t.tier}": max qty must be ≥ min qty.`);
      }
      for (const lane of activeLanes) {
        if (t.prices[lane.key] == null || t.prices[lane.key] < 0) {
          errors.push(`Tier "${t.tier}" missing valid price for lane "${lane.key}".`);
        }
      }
      if (i < c.tiers.length - 1 && t.maxQty !== null) {
        const next = c.tiers[i + 1];
        if (next.minQty !== t.maxQty + 1) {
          errors.push(`Gap between tier "${t.tier}" and "${next.tier}".`);
        }
      }
    }

    // Final tier must be open-ended
    if (c.tiers.length > 0) {
      const last = c.tiers[c.tiers.length - 1];
      if (last.maxQty !== null) {
        errors.push(`Final tier "${last.tier}" must be open-ended (no max quantity).`);
      }
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
          configType: "dtf_matrix",
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
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const updateTierPrice = (tierIdx: number, laneKey: string, value: string) => {
    if (!config || rollbackInProgress) return;
    const num = parseFloat(value);
    setConfig({
      ...config,
      tiers: config.tiers.map((t, i) =>
        i === tierIdx
          ? { ...t, prices: { ...t.prices, [laneKey]: Number.isFinite(num) ? num : 0 } }
          : t
      ),
    });
  };

  const updateTierRange = (tierIdx: number, field: "minQty" | "maxQty", value: string) => {
    if (!config || rollbackInProgress) return;
    const num = parseInt(value, 10);
    setConfig({
      ...config,
      tiers: config.tiers.map((t, i) =>
        i === tierIdx ? { ...t, [field]: Number.isFinite(num) ? num : 1 } : t
      ),
    });
  };

  const updateTierLabel = (tierIdx: number, value: string) => {
    if (!config || rollbackInProgress) return;
    setConfig({
      ...config,
      tiers: config.tiers.map((t, i) =>
        i === tierIdx ? { ...t, tier: value } : t
      ),
    });
  };

  const toggleOpenEnded = (tierIdx: number) => {
    if (!config || rollbackInProgress) return;
    setConfig({
      ...config,
      tiers: config.tiers.map((t, i) =>
        i === tierIdx
          ? { ...t, maxQty: t.maxQty === null ? t.minQty + 99 : null }
          : t
      ),
    });
  };

  const addTier = () => {
    if (!config || rollbackInProgress) return;
    const lastTier = config.tiers[config.tiers.length - 1];
    const newMin = lastTier
      ? lastTier.maxQty !== null
        ? lastTier.maxQty + 1
        : lastTier.minQty + 100
      : 1;
    const prices: Record<string, number> = {};
    for (const lane of config.lanes) {
      prices[lane.key] = lastTier?.prices[lane.key] ?? 0;
    }
    const existingTiers = config.tiers.map((tier, index) =>
      index === config.tiers.length - 1 && tier.maxQty === null
        ? { ...tier, maxQty: newMin - 1 }
        : tier
    );
    setConfig({
      ...config,
      tiers: [
        ...existingTiers,
        { tier: `${newMin}+`, minQty: newMin, maxQty: null, prices },
      ],
    });
  };

  const deleteTier = (tierIdx: number) => {
    if (!config || rollbackInProgress) return;
    if (!window.confirm(`Delete tier "${config.tiers[tierIdx].tier}"?`)) return;
    const remaining = config.tiers.filter((_, i) => i !== tierIdx);
    const normalized = remaining.map((tier, index) => {
      const normalizedTier = {
        ...tier,
        minQty: index === 0 ? 1 : tier.minQty,
      };
      if (index === remaining.length - 1) {
        return { ...normalizedTier, maxQty: null };
      }
      const next = remaining[index + 1];
      return { ...normalizedTier, maxQty: next.minQty - 1 };
    });
    setConfig({ ...config, tiers: normalized });
  };

  const updateLane = (laneIdx: number, field: keyof DtfLane, value: string | number | boolean) => {
    if (!config || rollbackInProgress) return;
    setConfig({
      ...config,
      lanes: config.lanes.map((l, i) =>
        i === laneIdx ? { ...l, [field]: value } : l
      ),
    });
  };

  const addLane = () => {
    if (!config || rollbackInProgress) return;
    const existingKeys = new Set(config.lanes.map((l) => l.key));
    let idx = config.lanes.length + 1;
    let key = `T${idx}`;
    while (existingKeys.has(key)) key = `T${++idx}`;
    const newLane: DtfLane = { key, label: key, margin: 0.3, active: true };
    setConfig({
      ...config,
      lanes: [...config.lanes, newLane],
      tiers: config.tiers.map((t) => ({
        ...t,
        prices: { ...t.prices, [key]: 0 },
      })),
    });
  };

  const deleteLane = (laneIdx: number) => {
    if (!config || rollbackInProgress) return;
    const lane = config.lanes[laneIdx];
    if (!window.confirm(`Delete lane "${lane.label}"?`)) return;
    setConfig({
      ...config,
      lanes: config.lanes.filter((_, i) => i !== laneIdx),
      tiers: config.tiers.map((t) => {
        const { [lane.key]: _, ...rest } = t.prices;
        return { ...t, prices: rest };
      }),
    });
  };

  const activeLanes = useMemo(
    () => config?.lanes.filter((l) => l.active) ?? [],
    [config]
  );

  if (loading && !config) {
    return (
      <div className="text-center py-8 text-sm text-neutral-400">
        Loading DTF Matrix...
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-200" id="dtf-matrix-heading">
            DTF Pricing Matrix
          </h2>
          <div className="text-[10px] text-neutral-500 mt-0.5">
            Source: {source === "database" ? "Database" : "Baseline"}{" "}
            {version && (
              <>
                · v{version.id.slice(0, 8)} by {version.createdBy}{" "}
                {version.activatedAt && `· Activated ${new Date(version.activatedAt).toLocaleDateString()}`}
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <VersionHistoryPanel
            configType="dtf_matrix"
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
              className="text-xs px-3 py-1.5 rounded bg-neutral-700 text-neutral-200 hover:bg-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Edit Matrix
            </button>
          ) : (
            <>
              <button
                onClick={handleCancel}
                className="text-xs px-3 py-1.5 rounded bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
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
              ) : (
                <span className="text-xs text-amber-400">Preview Only</span>
              )}
            </>
          )}
        </div>
      </div>

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

      {/* Lane config (editing mode only) */}
      {editing && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-neutral-300">Pricing Lanes</h3>
            <button
              onClick={addLane}
              className="text-[10px] px-2 py-1 rounded bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
            >
              + Add Lane
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {config.lanes.map((lane, idx) => (
              <div key={lane.key} className="p-2 rounded bg-neutral-800 border border-neutral-700 space-y-1">
                <div className="flex items-center justify-between">
                  <input
                    value={lane.label}
                    onChange={(e) => updateLane(idx, "label", e.target.value)}
                    className="w-16 text-xs bg-neutral-700 border border-neutral-600 rounded px-1.5 py-0.5 text-neutral-200"
                    aria-label={`Lane ${lane.key} label`}
                  />
                  <div className="flex items-center gap-1">
                    <label className="text-[10px] text-neutral-500">
                      <input
                        type="checkbox"
                        checked={lane.active}
                        onChange={(e) => updateLane(idx, "active", e.target.checked)}
                        className="mr-1"
                      />
                      Active
                    </label>
                    <button
                      onClick={() => deleteLane(idx)}
                      className="text-[10px] text-red-400 hover:text-red-300 ml-1"
                      aria-label={`Delete lane ${lane.label}`}
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-neutral-500">Key:</span>
                  <span className="text-[10px] text-neutral-400 font-mono">{lane.key}</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-neutral-500">Margin:</span>
                  <input
                    type="number"
                    value={Math.round(lane.margin * 100)}
                    onChange={(e) =>
                      updateLane(idx, "margin", parseInt(e.target.value, 10) / 100 || 0)
                    }
                    min="0"
                    max="99"
                    className="w-12 text-[10px] bg-neutral-700 border border-neutral-600 rounded px-1 py-0.5 text-neutral-200"
                    aria-label={`Lane ${lane.key} margin percent`}
                  />
                  <span className="text-[10px] text-neutral-500">%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Matrix table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs" aria-labelledby="dtf-matrix-heading">
          <thead>
            <tr className="border-b border-neutral-700">
              <th className="text-left py-2 px-2 text-neutral-400 font-medium sticky left-0 bg-neutral-900 z-10">
                Tier
              </th>
              <th className="text-left py-2 px-2 text-neutral-400 font-medium">Qty Range</th>
              {activeLanes.map((lane) => (
                <th key={lane.key} className="text-right py-2 px-2 text-neutral-400 font-medium min-w-[80px]">
                  {lane.label}
                  <div className="text-[10px] font-normal text-neutral-500">
                    {Math.round(lane.margin * 100)}%
                  </div>
                </th>
              ))}
              {editing && <th className="w-8" />}
            </tr>
          </thead>
          <tbody>
            {config.tiers.map((tier, tierIdx) => {
              const isLast = tierIdx === config.tiers.length - 1;
              return (
                <tr key={tierIdx} className="border-b border-neutral-800 hover:bg-neutral-800/50">
                  <td className="py-1.5 px-2 text-neutral-200 font-medium sticky left-0 bg-neutral-900 z-10">
                    {editing ? (
                      <input
                        value={tier.tier}
                        onChange={(e) => updateTierLabel(tierIdx, e.target.value)}
                        className="w-16 text-xs bg-neutral-800 border border-neutral-600 rounded px-1.5 py-0.5 text-neutral-200"
                        aria-label={`Tier ${tierIdx + 1} label`}
                      />
                    ) : (
                      tier.tier
                    )}
                  </td>
                  <td className="py-1.5 px-2 text-neutral-400">
                    {editing ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          value={tier.minQty}
                          onChange={(e) => updateTierRange(tierIdx, "minQty", e.target.value)}
                          min="1"
                          className="w-14 text-xs bg-neutral-800 border border-neutral-600 rounded px-1.5 py-0.5 text-neutral-200"
                          aria-label={`Tier ${tier.tier} min qty`}
                        />
                        <span className="text-neutral-500">–</span>
                        {tier.maxQty !== null ? (
                          <input
                            type="number"
                            value={tier.maxQty}
                            onChange={(e) => updateTierRange(tierIdx, "maxQty", e.target.value)}
                            min={tier.minQty}
                            className="w-14 text-xs bg-neutral-800 border border-neutral-600 rounded px-1.5 py-0.5 text-neutral-200"
                            aria-label={`Tier ${tier.tier} max qty`}
                          />
                        ) : (
                          <span className="text-[10px] text-cyan-400">∞</span>
                        )}
                        {isLast && (
                          <button
                            onClick={() => toggleOpenEnded(tierIdx)}
                            className="text-[10px] text-neutral-400 hover:text-neutral-200 ml-1"
                            title={tier.maxQty === null ? "Set upper bound" : "Make open-ended"}
                          >
                            {tier.maxQty === null ? "cap" : "∞"}
                          </button>
                        )}
                      </div>
                    ) : (
                      formatQtyRange(tier.minQty, tier.maxQty)
                    )}
                  </td>
                  {activeLanes.map((lane) => (
                    <td key={lane.key} className="py-1.5 px-2 text-right font-mono text-neutral-200">
                      {editing ? (
                        <input
                          type="number"
                          value={tier.prices[lane.key] ?? ""}
                          onChange={(e) => updateTierPrice(tierIdx, lane.key, e.target.value)}
                          step="0.05"
                          min="0"
                          className="w-16 text-xs text-right bg-neutral-800 border border-neutral-600 rounded px-1.5 py-0.5 text-neutral-200"
                          aria-label={`Tier ${tier.tier} ${lane.label} price`}
                        />
                      ) : (
                        fmtCurrency(tier.prices[lane.key] ?? 0)
                      )}
                    </td>
                  ))}
                  {editing && (
                    <td className="py-1.5 px-1">
                      <button
                        onClick={() => deleteTier(tierIdx)}
                        className="text-red-400 hover:text-red-300 text-[10px]"
                        aria-label={`Delete tier ${tier.tier}`}
                      >
                        ×
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <button
          onClick={addTier}
          className="text-[10px] px-2.5 py-1 rounded bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
        >
          + Add Tier
        </button>
      )}

      <div className="text-[10px] text-neutral-500 text-center">
        {config.tiers.length} tiers · {activeLanes.length} active lanes ·
        {config.tiers.length > 0 && (
          <>
            {" "}Qty {config.tiers[0].minQty}–
            {config.tiers[config.tiers.length - 1].maxQty === null
              ? "∞"
              : config.tiers[config.tiers.length - 1].maxQty?.toLocaleString()}
          </>
        )}
      </div>
    </div>
  );
}
