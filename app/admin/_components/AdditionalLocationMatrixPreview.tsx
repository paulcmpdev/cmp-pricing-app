"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtCurrency, fmtDelta, fmtQtyRange } from "./pricing-helpers";

const LANES = ["T1", "T2", "T3", "T4"] as const;
type Lane = (typeof LANES)[number];
const DEBOUNCE_MS = 400;

const DEFAULT_MARGINS: Record<Lane, number> = { T1: 58, T2: 52, T3: 44, T4: 35 };

type PriceCell = { current: number; draft: number; delta: number };
type MatrixRow = {
  printKey: string;
  location: string;
  widthIn: number;
  heightIn: number;
  tier: string;
  minQty: number;
  maxQty: number;
  cogsPerPiece: number;
  prices: Record<Lane, PriceCell>;
};

type PreviewResponse = {
  marginLanes: Record<Lane, number>;
  draftMargins: Record<Lane, number>;
  isDirty: boolean;
  rows: MatrixRow[];
};

type MarginErrors = Partial<Record<Lane, string>>;

function validateMarginInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "Required";
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) return "Enter a number";
  if (numeric < 0) return "Min 0%";
  if (numeric > 0 && numeric < 1) return "Enter percentage points, e.g. 58 for 58%";
  if (numeric >= 100) return "Max 99%";
  return null;
}

function parseValidMargin(value: string): number | null {
  return validateMarginInput(value) === null ? Number(value.trim()) : null;
}

function isMarginEdited(lane: Lane, value: string): boolean {
  const val = parseValidMargin(value);
  if (val !== null) return val !== DEFAULT_MARGINS[lane];
  return value.trim() !== String(DEFAULT_MARGINS[lane]);
}

function buildValidMarginEdits(margins: Record<Lane, string>) {
  const edits: Record<string, number> = {};
  for (const lane of LANES) {
    const val = parseValidMargin(margins[lane]);
    if (val !== null && val !== DEFAULT_MARGINS[lane]) {
      edits[lane] = val;
    }
  }
  return edits;
}

export default function AdditionalLocationMatrixPreview() {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [margins, setMargins] = useState<Record<Lane, string>>({
    T1: String(DEFAULT_MARGINS.T1),
    T2: String(DEFAULT_MARGINS.T2),
    T3: String(DEFAULT_MARGINS.T3),
    T4: String(DEFAULT_MARGINS.T4),
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [marginErrors, setMarginErrors] = useState<MarginErrors>({});
  const abortRef = useRef<AbortController | null>(null);
  const requestTokenRef = useRef(0);
  const dirtyRef = useRef(false);
  const appliedDirtyRef = useRef(false);
  const needsBaselineResetRef = useRef(false);
  const invalidLanes = Object.keys(marginErrors).length;
  const isDirty = LANES.some((lane) => isMarginEdited(lane, margins[lane]));
  const previewPaused = invalidLanes > 0;

  useEffect(() => {
    dirtyRef.current = isDirty;
  }, [isDirty]);

  const fetchPreview = useCallback(async (edits: Record<string, number>) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const token = ++requestTokenRef.current;
    setLoading(true);

    try {
      const res = await fetch("/api/admin/pricing/additional-locations/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edits }),
        signal: controller.signal,
      });
      if (token !== requestTokenRef.current || abortRef.current !== controller) return;
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ? JSON.stringify(err.error) : `HTTP ${res.status}`);
      }
      const data: PreviewResponse = await res.json();
      if (token !== requestTokenRef.current || abortRef.current !== controller) return;
      appliedDirtyRef.current = data.isDirty;
      setPreview(data);
      setError(null);
    } catch (e) {
      if (
        (e as Error).name !== "AbortError" &&
        token === requestTokenRef.current &&
        abortRef.current === controller
      ) {
        setError((e as Error).message);
      }
    } finally {
      if (token === requestTokenRef.current && abortRef.current === controller) {
        setLoading(false);
      }
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchPreview({});
  }, [fetchPreview]);

  // Debounced recalc on margin changes
  useEffect(() => {
    const edits = buildValidMarginEdits(margins);
    const hasEdits = Object.keys(edits).length > 0;
    if (previewPaused) {
      abortRef.current?.abort();
      abortRef.current = null;
      requestTokenRef.current += 1;
      setLoading(false);
      return;
    }
    if (!hasEdits && !appliedDirtyRef.current && !needsBaselineResetRef.current) return;

    const timer = setTimeout(() => {
      needsBaselineResetRef.current = false;
      fetchPreview(edits);
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [margins, fetchPreview, previewPaused]);

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

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      requestTokenRef.current += 1;
    };
  }, []);

  const handleMarginChange = (lane: Lane, value: string) => {
    setMargins((prev) => ({ ...prev, [lane]: value }));
    setMarginErrors((prev) => {
      const next = { ...prev };
      const errorMsg = validateMarginInput(value);
      if (errorMsg) {
        next[lane] = errorMsg;
      } else {
        delete next[lane];
      }
      return next;
    });
  };

  const resetLane = (lane: Lane) => {
    if (isDirty) needsBaselineResetRef.current = true;
    setMargins((prev) => ({ ...prev, [lane]: String(DEFAULT_MARGINS[lane]) }));
    setMarginErrors((prev) => {
      const next = { ...prev };
      delete next[lane];
      return next;
    });
  };

  const resetAll = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    requestTokenRef.current += 1;
    if (isDirty) needsBaselineResetRef.current = true;
    setMargins({
      T1: String(DEFAULT_MARGINS.T1),
      T2: String(DEFAULT_MARGINS.T2),
      T3: String(DEFAULT_MARGINS.T3),
      T4: String(DEFAULT_MARGINS.T4),
    });
    setMarginErrors({});
  };

  const editCount = useMemo(() => {
    let count = 0;
    for (const lane of LANES) {
      if (isMarginEdited(lane, margins[lane])) count++;
    }
    return count;
  }, [margins]);

  // Group rows by print key
  const groupedRows = useMemo(() => {
    if (!preview) return [];
    const groups = new Map<string, MatrixRow[]>();
    for (const row of preview.rows) {
      if (!groups.has(row.printKey)) groups.set(row.printKey, []);
      groups.get(row.printKey)!.push(row);
    }
    return Array.from(groups.entries());
  }, [preview]);

  if (loading && !preview) {
    return (
      <div className="text-center py-8 text-sm text-neutral-400">
        Loading Additional Location Matrix...
      </div>
    );
  }

  if (error && !preview) {
    return (
      <div className="rounded-md bg-red-900/30 border border-red-700 p-4 text-sm text-red-300" role="alert">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-200" id="al-matrix-heading">
          Additional Location Matrix
        </h2>
        <div className="flex items-center gap-3">
          {editCount > 0 && (
            <span className="text-xs text-amber-400" data-testid="al-change-count">
              {editCount} {editCount === 1 ? "change" : "changes"}
            </span>
          )}
          {previewPaused && (
            <span className="text-xs text-amber-300" data-testid="al-preview-paused">
              Preview paused; showing last valid prices.
            </span>
          )}
          <button
            onClick={resetAll}
            disabled={editCount === 0}
            className="text-xs px-2.5 py-1 rounded bg-neutral-700 text-neutral-300 hover:bg-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Reset all margin edits"
          >
            Reset All
          </button>
        </div>
      </div>

      <div className="rounded-md bg-amber-900/20 border border-amber-700/40 px-3 py-2 text-xs text-amber-300">
        <strong>Preview Only</strong> — Session-only component-margin editing. Edits are not saved or published and do not affect Quote Desk pricing.
        These are internal component-level margins from the captured workbook. They do not represent or guarantee quote-level final-item contribution targets (T1–T4: 50/45/40/35%).
      </div>

      {/* Global margin controls */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {LANES.map((lane) => {
          const isEdited = isMarginEdited(lane, margins[lane]);
          const errorMsg = marginErrors[lane] ?? null;
          return (
            <div key={lane} className="space-y-1">
              <div className="flex items-center justify-between">
                <label
                  htmlFor={`al-margin-${lane}`}
                  className="text-xs font-medium text-neutral-300"
                >
                  {lane} Component Margin
                </label>
                {isEdited && (
                  <button
                    onClick={() => resetLane(lane)}
                    className="text-[10px] text-cyan-400 hover:text-cyan-300"
                    aria-label={`Reset ${lane} margin`}
                  >
                    Reset
                  </button>
                )}
              </div>
              <div className="relative">
                <input
                  id={`al-margin-${lane}`}
                  type="number"
                  min="0"
                  max="99"
                  step="1"
                  value={margins[lane]}
                  onChange={(e) => handleMarginChange(lane, e.target.value)}
                  className={`w-full px-2.5 py-1.5 rounded text-sm bg-neutral-800 border text-neutral-200 focus:outline-none focus:ring-1 focus:ring-cyan-500 ${
                    errorMsg
                      ? "border-red-500"
                      : isEdited
                      ? "border-amber-500"
                      : "border-neutral-600"
                  }`}
                  aria-label={`${lane} component margin percent`}
                  aria-invalid={errorMsg ? "true" : "false"}
                  aria-describedby={errorMsg ? `al-margin-${lane}-error` : undefined}
                />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-neutral-500">%</span>
              </div>
              <div className="text-[10px] text-neutral-500">
                Default: {DEFAULT_MARGINS[lane]}%
              </div>
              {errorMsg && (
                <div id={`al-margin-${lane}-error`} className="text-[10px] text-red-300" role="alert">
                  {errorMsg}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Matrix table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs" aria-labelledby="al-matrix-heading">
          <thead>
            <tr className="border-b border-neutral-700">
              <th className="text-left py-2 px-2 text-neutral-400 font-medium sticky left-0 bg-neutral-900 z-10">Location</th>
              <th className="text-left py-2 px-2 text-neutral-400 font-medium">Tier</th>
              <th className="text-right py-2 px-2 text-neutral-400 font-medium">COGS</th>
              {LANES.map((lane) => (
                <th key={lane} className="text-right py-2 px-2 text-neutral-400 font-medium min-w-[80px]">
                  {lane}
                  {isMarginEdited(lane, margins[lane]) && (
                    <span className="ml-1 text-amber-400">*</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groupedRows.map(([printKey, rows]) => (
              <React.Fragment key={printKey}>
                {rows.map((row, idx) => (
                  <tr
                    key={`${row.printKey}-${row.tier}`}
                    className="border-b border-neutral-800 hover:bg-neutral-800/50"
                  >
                    {idx === 0 && (
                      <td
                        className="py-1.5 px-2 text-neutral-200 font-medium sticky left-0 bg-neutral-900 z-10"
                        rowSpan={rows.length}
                      >
                        <div>{row.location}</div>
                        <div className="text-[10px] text-neutral-500">
                          {row.widthIn}&times;{row.heightIn} in
                        </div>
                      </td>
                    )}
                    <td className="py-1.5 px-2 text-neutral-400">
                      {fmtQtyRange(row.minQty, row.maxQty)}
                    </td>
                    <td className="py-1.5 px-2 text-right text-neutral-400 font-mono">
                      {fmtCurrency(row.cogsPerPiece)}
                    </td>
                    {LANES.map((lane) => {
                      const cell = row.prices[lane];
                      const hasChange = cell.delta !== 0;
                      return (
                        <td
                          key={lane}
                          data-testid={`al-price-${row.printKey}-${row.tier}-${lane}`}
                          className={`py-1.5 px-2 text-right font-mono ${
                            hasChange ? "text-amber-300" : "text-neutral-200"
                          }`}
                        >
                          <div>
                            {hasChange && <span className="sr-only">Draft </span>}
                            {fmtCurrency(cell.draft)}
                          </div>
                          {hasChange && (
                            <div className="mt-1 grid grid-cols-3 gap-1 text-[10px] leading-tight text-left font-sans">
                              <span>
                                <span className="block uppercase text-neutral-500">Current</span>
                                <span className="font-mono text-neutral-300">{fmtCurrency(cell.current)}</span>
                              </span>
                              <span>
                                <span className="block uppercase text-neutral-500">Draft</span>
                                <span className="font-mono text-amber-300">{fmtCurrency(cell.draft)}</span>
                              </span>
                              <span>
                                <span className="block uppercase text-neutral-500">Delta</span>
                                <span className={`font-mono ${cell.delta > 0 ? "text-red-400" : "text-green-400"}`}>
                                  {fmtDelta(cell.delta)}
                                </span>
                              </span>
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-[10px] text-neutral-500 text-center">
        {preview?.rows.length ?? 0} rows · 13 locations · 8 tiers ·
        Component price formula: ceil(COGS / (1 - component margin), $0.05) · Not a final-item contribution target
      </div>
    </div>
  );
}
