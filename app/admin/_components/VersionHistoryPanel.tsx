"use client";

import React, { useCallback, useState } from "react";

type HistoryEntry = {
  id: string;
  status: "active" | "superseded";
  createdBy: string;
  createdAt: string;
  activatedAt: string | null;
  supersededAt: string | null;
};

type Props = {
  configType: "dtf_matrix" | "additional_prints";
  currentVersionId: string | null;
  persistenceEnabled: boolean;
  onRolledBack: () => void | Promise<void>;
  isDraftDirty?: boolean;
  // Notified with `true` right before the activation request fires and
  // `false` only once the parent's post-rollback reload (onRolledBack) has
  // fully resolved — so the parent can lock out edit-mode entry and draft
  // mutation for the whole activation/reload lifecycle, not just the fetch.
  onRollbackStateChange?: (inProgress: boolean) => void;
};

export default function VersionHistoryPanel({
  configType,
  currentVersionId,
  persistenceEnabled,
  onRolledBack,
  isDraftDirty = false,
  onRollbackStateChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/pricing/config/history?type=${configType}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setEntries(data.versions);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [configType]);

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next) fetchHistory();
  };

  if (!persistenceEnabled) {
    return (
      <div
        className="text-[10px] text-neutral-500 italic px-2 py-1"
        data-testid="version-history-preview-only"
      >
        Version History unavailable — Preview Only mode (enable persistence to track
        and roll back saved versions).
      </div>
    );
  }

  const handleRollback = async (versionId: string) => {
    if (isDraftDirty) {
      setError(
        "You have unsaved draft changes. Save or discard them before rolling back a version."
      );
      return;
    }
    if (
      !window.confirm(
        "Roll back to this version? This creates a new active copy from the historical snapshot."
      )
    ) {
      return;
    }
    setRollingBackId(versionId);
    setError(null);
    onRollbackStateChange?.(true);
    try {
      const res = await fetch("/api/admin/pricing/config/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          configType,
          versionId,
          expectedCurrentVersionId: currentVersionId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await fetchHistory();
      // Awaited so the parent's reload (which replaces the draft with the
      // rolled-back data) finishes before the "in progress" lock is lifted.
      await onRolledBack();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRollingBackId(null);
      onRollbackStateChange?.(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        onClick={toggleOpen}
        className="text-[10px] px-2 py-1 rounded bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
      >
        {open ? "Hide History" : "Version History"}
      </button>
      {open && (
        <div className="rounded-md bg-neutral-800 border border-neutral-700 p-3 space-y-2">
          {isDraftDirty && (
            <div
              className="rounded bg-amber-900/30 border border-amber-700 p-2 text-[10px] text-amber-300"
              role="alert"
              data-testid="version-history-dirty-warning"
            >
              You have unsaved draft changes. Save or discard them before rolling back a
              version.
            </div>
          )}
          {loading && <p className="text-[10px] text-neutral-400">Loading history...</p>}
          {error && (
            <div
              className="rounded bg-red-900/30 border border-red-700 p-2 text-[10px] text-red-300"
              role="alert"
            >
              {error}
            </div>
          )}
          {!loading && entries.length === 0 && !error && (
            <p className="text-[10px] text-neutral-500">No version history yet.</p>
          )}
          <ul className="space-y-1">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-2 text-[10px] text-neutral-300 py-1 border-b border-neutral-700/50 last:border-0"
              >
                <div>
                  <span className="font-mono text-neutral-400">v{entry.id.slice(0, 8)}</span>{" "}
                  <span className={entry.status === "active" ? "text-cyan-400" : "text-neutral-400"}>
                    {entry.status}
                  </span>{" "}
                  <span className="text-neutral-400">
                    · {entry.createdBy} · {new Date(entry.createdAt).toLocaleString()}
                  </span>
                </div>
                {entry.status !== "active" && persistenceEnabled && (
                  <button
                    onClick={() => handleRollback(entry.id)}
                    disabled={rollingBackId !== null || isDraftDirty}
                    title={
                      isDraftDirty
                        ? "Save or discard your unsaved draft changes before rolling back"
                        : undefined
                    }
                    className="text-[10px] px-2 py-0.5 rounded bg-amber-800/60 text-amber-200 hover:bg-amber-700/60 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                    aria-label={`Roll back to version ${entry.id.slice(0, 8)} created ${new Date(entry.createdAt).toLocaleString()}`}
                  >
                    {rollingBackId === entry.id ? "Rolling back..." : "Rollback"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
