"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marginFromPrice, tierCostKey } from "@/lib/pricing/dtf-margin-math";
import type { DtfTierCostBasis } from "@/lib/pricing/dtf-matrix-preview-types";
import VersionHistoryPanel from "./VersionHistoryPanel";
import DtfPriceCell, { type CellInputError } from "./dtf-matrix/DtfPriceCell";
import DtfPricingContext from "./dtf-matrix/DtfPricingContext";
import DtfQuoteImpact, {
  type QuoteFieldErrors,
  type QuoteInputs,
} from "./dtf-matrix/DtfQuoteImpact";
import { useDtfMatrixPreview } from "./dtf-matrix/useDtfMatrixPreview";

const FALLBACK_MAX_QUANTITY = 5000;
// Mirrors DtfQuoteInputSchema.productCost in lib/pricing/dtf-matrix-preview.ts.
// Above this the preview API answers 400, so catching it inline keeps the
// admin out of a pointless round-trip.
const MAX_PRODUCT_COST = 100_000;

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

/**
 * Parent-side identity for one price/GM% cell. Row index keeps two rows that
 * transiently share a quantity span from colliding; the span makes the key
 * change whenever a row's content is replaced (tier deleted, span re-typed),
 * which is what lets the cell drop a typed-GM% buffer that no longer applies.
 */
function cellKeyFor(tierIdx: number, tier: DtfTier, laneKey: string): string {
  return `${tierIdx}|${tierCostKey(tier.minQty, tier.maxQty)}|${laneKey}`;
}

function formatQtyRange(min: number, max: number | null): string {
  if (max === null) return `${min.toLocaleString()}+`;
  if (min === max) return String(min);
  return `${min.toLocaleString()}-${max.toLocaleString()}`;
}

/**
 * Lane "Default GM%" is persisted as a fraction in [0, 1). Clamp here so a
 * stray 100 (or a cleared field) can't produce a value the save schema
 * rejects only later, at the end of a long edit.
 */
function parseLanePercent(raw: string): number {
  const percent = parseInt(raw, 10);
  if (!Number.isFinite(percent)) return 0;
  return Math.min(Math.max(percent, 0), 99) / 100;
}

function validateQuoteInputs(
  inputs: QuoteInputs,
  maxQuantity: number,
  maxProductCost: number
): QuoteFieldErrors {
  const errors: QuoteFieldErrors = {};
  const cost = parseFloat(inputs.productCost);
  const qty = Number(inputs.quantity);

  if (
    inputs.productCost.trim() === "" ||
    !Number.isFinite(cost) ||
    cost < 0 ||
    cost > maxProductCost
  ) {
    errors.productCost = `Enter a cost of 0-${maxProductCost.toLocaleString()}.`;
  }
  if (
    inputs.quantity.trim() === "" ||
    !Number.isInteger(qty) ||
    qty < 1 ||
    qty > maxQuantity
  ) {
    errors.quantity = `Whole number 1-${maxQuantity.toLocaleString()}.`;
  }
  return errors;
}

// Only the last tier may be missing a maxQty, and each subsequent tier must
// start exactly one unit after the previous tier's max — same shape the
// summary bar's "Quantity Coverage" sub-label describes to the admin.
function tiersAreContiguous(tiers: DtfTier[]): boolean {
  for (let i = 0; i < tiers.length - 1; i++) {
    const tier = tiers[i];
    if (tier.maxQty === null) return false;
    if (tiers[i + 1].minQty !== tier.maxQty + 1) return false;
  }
  return true;
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
  // Live input errors owned by individual price/GM% cells, keyed by
  // cellKeyFor(). A cell that rejects a typed GM% leaves the price at its
  // prior valid value, so the draft alone looks saveable — this registry is
  // the only thing that knows otherwise.
  const [cellErrors, setCellErrors] = useState<Record<string, CellInputError>>({});
  const [rollbackInProgress, setRollbackInProgress] = useState(false);
  const [quoteInputs, setQuoteInputs] = useState<QuoteInputs>({
    productCost: "4.80",
    quantity: "174",
    lane: "",
  });
  // Selected row for the sticky Quantity Inspector / mobile expanded card.
  const [selectedTierIdx, setSelectedTierIdx] = useState(0);
  // Visual-only lane focus (chips + focused column). Never mutates config.
  const [focusLaneKey, setFocusLaneKey] = useState<string>("");
  const [isDesktop, setIsDesktop] = useState(true);
  // Advanced configuration surfaces, subordinate to the read-first matrix.
  const [manageLanesOpen, setManageLanesOpen] = useState(false);
  const [manageQuantitiesOpen, setManageQuantitiesOpen] = useState(false);
  const initializedTierSelectionRef = useRef(false);
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

  // Persist errors across selection/responsive unmounts, pruning only cells
  // that are no longer part of the full editable matrix.
  useEffect(() => {
    if (!config) return;
    const renderableKeys = new Set(
      config.tiers.flatMap((tier, tierIdx) =>
        config.lanes
          .filter((lane) => lane.active)
          .map((lane) => cellKeyFor(tierIdx, tier, lane.key))
      )
    );
    setCellErrors((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([key]) => renderableKeys.has(key))
      );
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [config]);

  // Stable across renders so cell input handlers can update the registry
  // without changing callback identity.
  const handleCellValidityChange = useCallback(
    (cellKey: string, cellError: CellInputError | null) => {
      setCellErrors((prev) => {
        if (!cellError) {
          if (!(cellKey in prev)) return prev;
          const { [cellKey]: _removed, ...rest } = prev;
          return rest;
        }
        const existing = prev[cellKey];
        if (
          existing &&
          existing.rawText === cellError.rawText &&
          existing.label === cellError.label &&
          existing.message === cellError.message
        ) {
          return prev;
        }
        return { ...prev, [cellKey]: cellError };
      });
    },
    []
  );

  const cellErrorEntries = useMemo(() => Object.entries(cellErrors), [cellErrors]);
  const hasCellErrors = cellErrorEntries.length > 0;

  const handleEdit = () => {
    if (rollbackInProgress) return;
    setCellErrors({});
    setEditing(true);
    setValidationErrors([]);
  };

  const handleCancel = () => {
    if (isDirty && !window.confirm("Discard unsaved changes?")) return;
    setConfig(originalConfig ? JSON.parse(JSON.stringify(originalConfig)) : null);
    setEditing(false);
    setValidationErrors([]);
    setCellErrors({});
    setManageLanesOpen(false);
    setManageQuantitiesOpen(false);
  };

  const handleSave = async () => {
    if (!config || !persistenceEnabled || rollbackInProgress) return;
    // Belt-and-braces with the disabled Save button: a cell input error means
    // the draft's prices no longer match what the admin last typed, so the
    // draft is not the thing they mean to persist.
    if (hasCellErrors) return;
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
      setCellErrors({});
      setError(null);
      setManageLanesOpen(false);
      setManageQuantitiesOpen(false);
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
    // Seed from the last existing lane rather than $0, so every cell in the
    // new column starts above labor recovery and shows a real DTF GM%
    // instead of an immediate below-cost error.
    const seedKey = config.lanes[config.lanes.length - 1]?.key;
    setConfig({
      ...config,
      lanes: [...config.lanes, newLane],
      tiers: config.tiers.map((t) => ({
        ...t,
        prices: {
          ...t.prices,
          [key]: (seedKey != null ? t.prices[seedKey] : undefined) ?? 0,
        },
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

  // Keep the Quote Impact lane selector pointed at a lane that still exists —
  // lanes can be renamed, deactivated, or deleted mid-draft.
  useEffect(() => {
    if (activeLanes.length === 0) return;
    if (activeLanes.some((lane) => lane.key === quoteInputs.lane)) return;
    setQuoteInputs((prev) => ({ ...prev, lane: activeLanes[0].key }));
  }, [activeLanes, quoteInputs.lane]);

  // Keep the lane focus chip pointed at a lane that still exists.
  useEffect(() => {
    if (activeLanes.length === 0) return;
    if (activeLanes.some((lane) => lane.key === focusLaneKey)) return;
    setFocusLaneKey(activeLanes[0].key);
  }, [activeLanes, focusLaneKey]);

  // Keep the selected row in range as tiers are added/removed.
  useEffect(() => {
    if (!config) return;
    if (selectedTierIdx > config.tiers.length - 1) {
      setSelectedTierIdx(Math.max(0, config.tiers.length - 1));
    }
  }, [config, selectedTierIdx]);

  // Align the first inspector/card selection with the quote preview's default
  // quantity. This runs once after the initial config arrives, so later user
  // selection is never reset by draft edits or background preview responses.
  useEffect(() => {
    if (!config || initializedTierSelectionRef.current) return;
    initializedTierSelectionRef.current = true;
    const defaultQuantity = Number(quoteInputs.quantity);
    const defaultTierIdx = config.tiers.findIndex(
      (tier) =>
        defaultQuantity >= tier.minQty &&
        (tier.maxQty === null || defaultQuantity <= tier.maxQty)
    );
    if (defaultTierIdx >= 0) setSelectedTierIdx(defaultTierIdx);
  }, [config, quoteInputs.quantity]);

  // Both client bounds mirror DtfQuoteInputSchema (quantity from the
  // contract's maximumWithoutManagerReview, cost from its 100,000 cap). The
  // preview API re-validates them, so this is UX guidance, not the authority —
  // but it must not be *stricter*, or a legal quote would never be sent.
  const quoteErrors = useMemo(
    () =>
      validateQuoteInputs(quoteInputs, FALLBACK_MAX_QUANTITY, MAX_PRODUCT_COST),
    [quoteInputs]
  );

  const quoteRequest = useMemo(() => {
    if (quoteErrors.productCost || quoteErrors.quantity) return null;
    if (!quoteInputs.lane) return null;
    return {
      productCost: parseFloat(quoteInputs.productCost),
      quantity: Number(quoteInputs.quantity),
      lane: quoteInputs.lane,
    };
  }, [quoteInputs, quoteErrors]);

  const {
    preview,
    quoteImpact,
    recalculating,
    error: previewError,
  } = useDtfMatrixPreview({
    draft: config,
    saved: originalConfig,
    quote: quoteRequest,
    enabled: config != null,
  });

  const costBases = preview?.costBases ?? null;
  const roundingIncrement = preview?.pricingPolicy.roundingIncrement ?? "0.05";
  const maxQuantity =
    preview?.dtfContext.maxSupportedQuantity ?? FALLBACK_MAX_QUANTITY;

  /**
   * Cost basis for a tier, keyed by its quantity span only — so a rename or
   * reorder reuses the cached basis instead of blanking the GM% column while
   * the next preview round-trips.
   */
  const basisForTier = useCallback(
    (tier: DtfTier): DtfTierCostBasis | null =>
      costBases?.[tierCostKey(tier.minQty, tier.maxQty)] ?? null,
    [costBases]
  );

  const handleQuoteChange = useCallback(
    (field: keyof QuoteInputs, value: string) => {
      setQuoteInputs((prev) => ({ ...prev, [field]: value }));
    },
    []
  );

  // ---- Summary bar derived values ----
  const quantityCoverage = useMemo(() => {
    if (!config || config.tiers.length === 0) return null;
    const first = config.tiers[0];
    const last = config.tiers[config.tiers.length - 1];
    const rangeLabel = `${first.minQty.toLocaleString()}–${
      last.maxQty === null ? `${last.minQty.toLocaleString()}+` : last.maxQty.toLocaleString()
    } units`;
    const contiguous = tiersAreContiguous(config.tiers);
    const subLabel = `${config.tiers.length} quantities, ${
      contiguous ? "single contiguous break schedule" : "non-contiguous break schedule"
    }`;
    return { rangeLabel, subLabel };
  }, [config]);

  const sourceSummary = useMemo(() => {
    if (!config) return null;
    const bases = config.tiers.map((tier) => basisForTier(tier));
    const resolved = bases.filter((b): b is DtfTierCostBasis => b != null);
    const mainLabel =
      resolved.length === 0
        ? "Pending"
        : resolved.every((b) => b.source === "contract")
          ? "Contract rates"
          : resolved.some((b) => b.source === "contract")
            ? "Mixed rates"
            : "Engine rates";
    const first = bases[0];
    const last = bases[bases.length - 1];
    const subLabel =
      first && last
        ? `basis q${first.costingQty}–q${last.costingQty}`
        : "basis pending";
    return { mainLabel, subLabel };
  }, [config, basisForTier]);

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

  const selectedTier = config.tiers[selectedTierIdx] ?? config.tiers[0] ?? null;
  const selectedTierBasis = selectedTier ? basisForTier(selectedTier) : null;
  const isDirtyDraft = editing && isDirty;
  const editStateLabel = isDirtyDraft
    ? "Draft · unsaved edits"
    : editing
      ? "Editing · no changes yet"
      : "Preview · unedited";

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950 overflow-hidden">
      {/* Studio header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-neutral-800 bg-neutral-900/60 px-4 sm:px-5 py-4">
        <div>
          <h2 className="text-[19px] font-bold tracking-tight text-neutral-100" id="dtf-matrix-heading">
            DTF Pricing Matrix
          </h2>
          <p className="mt-1 text-[12.5px] text-neutral-400">
            Direct-to-Film print pricing workspace &middot; scenario preview
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
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
                {editStateLabel}
              </span>
            )}
            <span className="inline-flex items-center rounded border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
              {config.tiers.length} quantities
            </span>
            <span className="inline-flex items-center rounded border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
              {activeLanes.length} lanes
            </span>
          </div>
        </div>
        <div className="flex items-start gap-2">
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
              className="min-h-[36px] text-xs px-3 py-1.5 rounded border border-cyan-700/40 bg-cyan-900/20 text-cyan-300 hover:bg-cyan-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Edit Matrix
            </button>
          ) : (
            <>
              <button
                onClick={handleCancel}
                className="min-h-[36px] text-xs px-3 py-1.5 rounded bg-neutral-800 border border-neutral-700 text-neutral-300 hover:bg-neutral-700"
              >
                Cancel
              </button>
              {persistenceEnabled ? (
                <button
                  onClick={handleSave}
                  disabled={
                    saving || validationErrors.length > 0 || hasCellErrors || !isDirty
                  }
                  title={
                    hasCellErrors
                      ? "Fix the highlighted price / DTF GM% cells before saving."
                      : undefined
                  }
                  className="min-h-[36px] text-xs px-3 py-1.5 rounded bg-cyan-700 text-white hover:bg-cyan-600 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {saving ? "Saving..." : "Save Changes"}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* Summary bar: four zones */}
      <div className="flex flex-wrap border-b border-neutral-800 bg-neutral-900/40">
        <div className="flex-1 min-w-[200px] border-r border-neutral-800/60 px-4 sm:px-5 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 mb-1.5">
            Lane Focus &middot; Target Gross Margin
          </div>
          <div className="flex flex-wrap gap-1.5">
            {activeLanes.map((lane) => (
              <button
                key={lane.key}
                type="button"
                onClick={() => setFocusLaneKey(lane.key)}
                aria-pressed={focusLaneKey === lane.key}
                className={`inline-flex min-h-[28px] items-center gap-1 rounded px-2.5 py-1 text-[11.5px] font-semibold border ${
                  focusLaneKey === lane.key
                    ? "border-cyan-500 bg-cyan-900/20 text-cyan-300"
                    : "border-neutral-700 bg-neutral-800 text-neutral-400 hover:border-neutral-600"
                }`}
              >
                {lane.label}
                <span className={focusLaneKey === lane.key ? "text-cyan-300/75" : "text-neutral-500"}>
                  {Math.round(lane.margin * 100)}%
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 min-w-[200px] border-r border-neutral-800/60 px-4 sm:px-5 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 mb-1.5">
            Quantity Coverage
          </div>
          <div className="text-[13.5px] font-medium text-neutral-200">
            {quantityCoverage?.rangeLabel ?? "--"}
            <span className="block mt-0.5 text-[11.5px] font-normal text-neutral-500">
              {quantityCoverage?.subLabel ?? ""}
            </span>
          </div>
        </div>
        <div className="flex-1 min-w-[200px] border-r border-neutral-800/60 px-4 sm:px-5 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 mb-1.5">
            Source
          </div>
          <div className="text-[13.5px] font-medium text-neutral-200">
            {sourceSummary?.mainLabel ?? "--"}
            <span className="block mt-0.5 text-[11.5px] font-normal text-neutral-500">
              {sourceSummary?.subLabel ?? ""}
            </span>
          </div>
        </div>
        <div className="flex-1 min-w-[200px] px-4 sm:px-5 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 mb-1.5">
            Edit State
          </div>
          <div className="flex items-center gap-2 text-[13px] font-semibold text-neutral-200">
            <span className={`h-[7px] w-[7px] rounded-full ${isDirtyDraft ? "bg-amber-400" : "bg-emerald-400"}`} />
            {editStateLabel}
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-5 py-4 space-y-4">

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

      {hasCellErrors && editing && (
        <div
          className="rounded-md bg-red-900/30 border border-red-700 p-3 text-xs text-red-300"
          role="alert"
          data-testid="dtf-cell-input-errors"
        >
          <strong>Unsaved cell input:</strong> fix the highlighted price / DTF
          GM% cells before saving — their prices still hold the last valid
          value, not what you typed.
          <ul className="mt-1 list-disc list-inside">
            {cellErrorEntries.map(([key, cellError]) => (
              <li key={key}>{cellError.label}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Manage Lanes — advanced lane configuration, subordinate to the matrix */}
      {editing && manageLanesOpen && (
        <div
          data-testid="dtf-manage-lanes-panel"
          aria-label="Manage Lanes"
          className="space-y-2 rounded-md border border-neutral-800 bg-neutral-900/60 p-3"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-300">
              Manage Lanes
            </h3>
            <div className="flex items-center gap-2">
              <button
                onClick={addLane}
                className="text-[10px] px-2 py-1 rounded bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
              >
                + Add Lane
              </button>
              <button
                onClick={() => setManageLanesOpen(false)}
                aria-label="Close Manage Lanes"
                className="text-[10px] px-2 py-1 rounded bg-neutral-800 border border-neutral-700 text-neutral-400 hover:text-neutral-200"
              >
                Done
              </button>
            </div>
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
                  <span
                    className="text-[10px] text-neutral-500"
                    title="Target DTF GM% used to seed prices for new tiers in this lane. Each cell's actual GM% is derived from its own price."
                  >
                    Default GM%:
                  </span>
                  <input
                    type="number"
                    value={Math.round(lane.margin * 100)}
                    onChange={(e) => updateLane(idx, "margin", parseLanePercent(e.target.value))}
                    min="0"
                    max="99"
                    className="w-12 text-[10px] bg-neutral-700 border border-neutral-600 rounded px-1 py-0.5 text-neutral-200 min-h-[28px]"
                    aria-label={`Lane ${lane.key} margin percent`}
                  />
                  <span className="text-[10px] text-neutral-500">%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Manage Quantities — advanced tier configuration, subordinate to the matrix */}
      {editing && isDesktop && manageQuantitiesOpen && (
        <div
          data-testid="dtf-manage-quantities-panel"
          aria-label="Manage Quantities"
          className="space-y-2 rounded-md border border-neutral-800 bg-neutral-900/60 p-3"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-300">
              Manage Quantities
            </h3>
            <div className="flex items-center gap-2">
              <button
                onClick={addTier}
                className="min-h-[28px] text-[10px] px-2 py-1 rounded bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
              >
                + Add Tier
              </button>
              <button
                onClick={() => setManageQuantitiesOpen(false)}
                aria-label="Close Manage Quantities"
                className="text-[10px] px-2 py-1 rounded bg-neutral-800 border border-neutral-700 text-neutral-400 hover:text-neutral-200"
              >
                Done
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            {config.tiers.map((tier, tierIdx) => {
              const isLast = tierIdx === config.tiers.length - 1;
              return (
                <div
                  key={tierIdx}
                  className="flex flex-wrap items-center gap-1.5 rounded bg-neutral-800 border border-neutral-700 px-2 py-1.5"
                >
                  <input
                    value={tier.tier}
                    onChange={(e) => updateTierLabel(tierIdx, e.target.value)}
                    className="w-20 text-[10px] bg-neutral-900 border border-neutral-600 rounded px-1.5 py-0.5 text-neutral-300"
                    aria-label={`Tier ${tierIdx + 1} label`}
                    title="Display label for this quantity row"
                  />
                  <input
                    type="number"
                    value={tier.minQty}
                    onChange={(e) => updateTierRange(tierIdx, "minQty", e.target.value)}
                    min="1"
                    className="w-14 text-[10px] bg-neutral-900 border border-neutral-600 rounded px-1 py-0.5 text-neutral-300"
                    aria-label={`Tier ${tier.tier} min qty`}
                  />
                  <span className="text-neutral-600">–</span>
                  {tier.maxQty !== null ? (
                    <input
                      type="number"
                      value={tier.maxQty}
                      onChange={(e) => updateTierRange(tierIdx, "maxQty", e.target.value)}
                      min={tier.minQty}
                      className="w-14 text-[10px] bg-neutral-900 border border-neutral-600 rounded px-1 py-0.5 text-neutral-300"
                      aria-label={`Tier ${tier.tier} max qty`}
                    />
                  ) : (
                    <span className="text-[10px] text-cyan-400 w-14 text-center">∞</span>
                  )}
                  {isLast && (
                    <button
                      onClick={() => toggleOpenEnded(tierIdx)}
                      className="text-[10px] text-neutral-400 hover:text-neutral-200"
                      title={tier.maxQty === null ? "Set upper bound" : "Make open-ended"}
                    >
                      {tier.maxQty === null ? "Set upper bound" : "Make open-ended"}
                    </button>
                  )}
                  <button
                    onClick={() => deleteTier(tierIdx)}
                    className="ml-auto text-[10px] text-red-400 hover:text-red-300"
                    aria-label={`Delete tier ${tier.tier}`}
                  >
                    Delete tier
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Matrix + read-only inspector workspace */}
      <div
        className={`grid grid-cols-1 gap-4 items-start ${
          editing ? "" : "lg:grid-cols-[1fr_340px]"
        }`}
      >
        {isDesktop && (
          <div
            data-testid="dtf-matrix-table-panel"
            className="rounded-md border border-neutral-800 bg-neutral-950 overflow-hidden"
          >
            <div className="flex items-center justify-between gap-3 px-3 py-2.5 border-b border-neutral-800 bg-neutral-900/60">
              <h3 className="text-[13.5px] font-semibold text-neutral-200">Pricing Matrix</h3>
              <div className="flex items-center gap-3">
                <span className="text-[11.5px] text-neutral-500">
                  {editing
                    ? "Select a row to edit its pricing inline"
                    : "Choose any row to view its pricing"}
                </span>
                {editing && (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setManageQuantitiesOpen((v) => !v)}
                      aria-pressed={manageQuantitiesOpen}
                      className="min-h-[28px] text-[10px] px-2 py-1 rounded border border-neutral-700 bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                    >
                      Manage Quantities
                    </button>
                    <button
                      type="button"
                      onClick={() => setManageLanesOpen((v) => !v)}
                      aria-pressed={manageLanesOpen}
                      className="min-h-[28px] text-[10px] px-2 py-1 rounded border border-neutral-700 bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                    >
                      Manage Lanes
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="overflow-x-auto max-w-full">
              <table className="w-full text-xs" aria-labelledby="dtf-matrix-heading">
                <thead>
                  <tr className="border-b border-neutral-700 bg-neutral-900">
                    <th className="text-left py-2 px-3 text-neutral-500 font-semibold uppercase tracking-wide text-[10px] sticky left-0 bg-neutral-900 z-10">
                      Quantity
                    </th>
                    {activeLanes.map((lane) => (
                      <th
                        key={lane.key}
                        className={`text-right py-2 px-3 font-semibold uppercase tracking-wide text-[10px] min-w-[112px] ${
                          focusLaneKey === lane.key ? "text-cyan-300 bg-cyan-900/10" : "text-neutral-500"
                        }`}
                      >
                        {lane.label}
                        <span
                          className={`block mt-0.5 font-normal normal-case tracking-normal text-[10px] ${
                            focusLaneKey === lane.key ? "text-cyan-300/80" : "text-neutral-500"
                          }`}
                        >
                          {Math.round(lane.margin * 100)}% target
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {config.tiers.map((tier, tierIdx) => {
                    const tierBasis = basisForTier(tier);
                    const isSelected = tierIdx === selectedTierIdx;
                    return (
                      <tr
                        key={tierIdx}
                        onClick={(event) => {
                          if (
                            event.target instanceof Element &&
                            event.target.closest("button, input, select, textarea, a")
                          ) {
                            return;
                          }
                          setSelectedTierIdx(tierIdx);
                        }}
                        className={`border-b border-neutral-800/70 hover:bg-neutral-800/40 ${
                          isSelected ? "bg-cyan-900/10 shadow-[inset_3px_0_0_0_rgba(34,211,238,0.6)]" : ""
                        } ${editing ? "cursor-pointer" : ""}`}
                      >
                        <td className="py-2 px-3 text-neutral-200 font-semibold sticky left-0 bg-neutral-950 z-10">
                          <div className="flex min-w-[132px] items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setSelectedTierIdx(tierIdx)}
                              aria-label={`Select quantity ${tier.tier}`}
                              aria-pressed={isSelected}
                              className="text-left hover:text-cyan-300"
                            >
                              {formatQtyRange(tier.minQty, tier.maxQty)}
                            </button>
                          </div>
                        </td>
                        {activeLanes.map((lane) => (
                          <td
                            key={lane.key}
                            className={`py-2 px-3 text-right font-mono text-neutral-200 align-top ${
                              focusLaneKey === lane.key
                                ? isSelected
                                  ? "bg-cyan-900/15"
                                  : "bg-cyan-900/5"
                                : ""
                            }`}
                          >
                            <DtfPriceCell
                              cellKey={`${cellKeyFor(tierIdx, tier, lane.key)}${
                                editing && isSelected ? "" : "|readonly"
                              }`}
                              tierLabel={tier.tier}
                              laneKey={lane.key}
                              laneLabel={lane.label}
                              price={tier.prices[lane.key]}
                              basis={tierBasis}
                              roundingIncrement={roundingIncrement}
                              editing={editing && isSelected}
                              disabled={rollbackInProgress}
                              persistedError={
                                cellErrors[cellKeyFor(tierIdx, tier, lane.key)]
                              }
                              onPriceChange={(value) =>
                                updateTierPrice(tierIdx, lane.key, String(value))
                              }
                              onValidityChange={handleCellValidityChange}
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {isDesktop && !editing && selectedTier && (
          <aside
            data-testid="dtf-quantity-inspector"
            aria-labelledby="dtf-inspector-heading"
            className="lg:sticky lg:top-4 rounded-md border border-neutral-800 bg-neutral-950 overflow-hidden"
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-neutral-800 bg-neutral-900/60">
              <h3 id="dtf-inspector-heading" className="text-[13.5px] font-semibold text-neutral-200">
                {editing ? "Editing Pricing" : "Pricing"}: {selectedTier.tier}
              </h3>
              <span className="text-[11.5px] text-neutral-500">{editing ? "Editing" : "Live"}</span>
            </div>
            <div className="p-3">
              <div className="flex items-baseline justify-between gap-2 mb-0.5">
                <div className="text-xl font-bold text-neutral-100 tracking-tight">
                  {formatQtyRange(selectedTier.minQty, selectedTier.maxQty)}
                </div>
                <span className="text-[11.5px] text-neutral-500">units / order</span>
              </div>
              <div className="text-[11.5px] font-mono text-neutral-500 mb-3">
                {selectedTierBasis
                  ? `${selectedTierBasis.source === "contract" ? "contract" : "engine"} · q${selectedTierBasis.costingQty}`
                  : "--"}
              </div>
              <div className="space-y-2">
                {activeLanes.map((lane) => {
                  const isFocused = focusLaneKey === lane.key;
                  return (
                    <div
                      key={lane.key}
                      className={`rounded border px-2.5 py-2 flex items-start justify-between gap-2 ${
                        isFocused
                          ? "border-cyan-700/40 bg-cyan-900/10"
                          : "border-neutral-800 bg-neutral-900"
                      }`}
                    >
                      <div className="text-[12px]">
                        <div className={`font-bold ${isFocused ? "text-cyan-300" : "text-neutral-300"}`}>
                          {lane.label}
                        </div>
                        <div className="text-[10.5px] text-neutral-500">
                          Target {Math.round(lane.margin * 100)}% GM
                        </div>
                      </div>
                      <DtfPriceCell
                        cellKey={cellKeyFor(selectedTierIdx, selectedTier, lane.key)}
                        tierLabel={selectedTier.tier}
                        laneKey={lane.key}
                        laneLabel={lane.label}
                        price={selectedTier.prices[lane.key]}
                        basis={selectedTierBasis}
                        roundingIncrement={roundingIncrement}
                        editing={editing}
                        disabled={rollbackInProgress}
                        persistedError={
                          cellErrors[cellKeyFor(selectedTierIdx, selectedTier, lane.key)]
                        }
                        onPriceChange={(value) =>
                          updateTierPrice(selectedTierIdx, lane.key, String(value))
                        }
                        onValidityChange={handleCellValidityChange}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </aside>
        )}

        {!isDesktop && (
          <div data-testid="dtf-mobile-tier-cards" className="space-y-2">
            {editing && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setManageLanesOpen((v) => !v)}
                  aria-pressed={manageLanesOpen}
                  className="min-h-[36px] flex-1 text-xs px-2 py-1.5 rounded border border-neutral-700 bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                >
                  Manage Lanes
                </button>
              </div>
            )}
            {config.tiers.map((tier, tierIdx) => {
              const isLast = tierIdx === config.tiers.length - 1;
              const tierBasis = basisForTier(tier);
              const expanded = tierIdx === selectedTierIdx;
              const primaryLane =
                activeLanes.find((l) => l.key === focusLaneKey) ?? activeLanes[0] ?? null;
              const primaryPrice = primaryLane ? tier.prices[primaryLane.key] : undefined;
              const primaryMargin =
                tierBasis && primaryPrice != null
                  ? marginFromPrice(tierBasis, primaryPrice)
                  : null;
              return (
                <div
                  key={tierIdx}
                  className={`rounded-md border overflow-hidden ${
                    expanded ? "border-cyan-700/40" : "border-neutral-800"
                  }`}
                >
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`Select quantity ${tier.tier}`}
                    onClick={() => setSelectedTierIdx(tierIdx)}
                    className="w-full min-h-[44px] flex items-center justify-between gap-2 px-3 py-2 text-left bg-neutral-900"
                  >
                    <div>
                      <div className="text-sm font-semibold text-neutral-100">
                        {formatQtyRange(tier.minQty, tier.maxQty)}
                      </div>
                      <div className="text-[10px] font-mono text-neutral-500">
                        {tierBasis
                          ? `${tierBasis.source === "contract" ? "contract" : "engine"} · q${tierBasis.costingQty}`
                          : "--"}
                      </div>
                    </div>
                    {primaryLane && (
                      <div className="text-right">
                        <div className="font-mono text-sm text-neutral-100">
                          {primaryPrice != null
                            ? `$${primaryPrice.toFixed(2)}`
                            : "--"}
                        </div>
                        <div className="text-[10px] text-neutral-500">
                          {primaryLane.label} · {primaryMargin?.ok
                            ? `${Number(primaryMargin.marginPercent).toFixed(1)}% GM`
                            : "GM --"}
                        </div>
                      </div>
                    )}
                  </button>
                  {expanded && (
                    <div className="p-3 space-y-2 border-t border-neutral-800">
                      {editing && (
                        <section
                          aria-labelledby={`mobile-tier-config-${tierIdx}`}
                          className="space-y-3 rounded border border-neutral-700 bg-neutral-900 p-3"
                        >
                          <h3
                            id={`mobile-tier-config-${tierIdx}`}
                            className="text-xs font-semibold text-neutral-200"
                          >
                            Quantity Configuration
                          </h3>
                          <label className="block space-y-1 text-[11px] text-neutral-400">
                            <span>Display label</span>
                            <input
                              value={tier.tier}
                              onChange={(e) => updateTierLabel(tierIdx, e.target.value)}
                              className="min-h-[40px] w-full rounded border border-neutral-600 bg-neutral-800 px-3 py-2 text-sm text-neutral-200"
                              aria-label={`Tier ${tierIdx + 1} label`}
                              title="Display label for this quantity row"
                            />
                          </label>
                          <label className="block space-y-1 text-[11px] text-neutral-400">
                            <span>Minimum quantity</span>
                            <input
                              type="number"
                              value={tier.minQty}
                              onChange={(e) =>
                                updateTierRange(tierIdx, "minQty", e.target.value)
                              }
                              min="1"
                              className="min-h-[40px] w-full rounded border border-neutral-600 bg-neutral-800 px-3 py-2 text-sm text-neutral-200"
                              aria-label={`Tier ${tier.tier} min qty`}
                            />
                          </label>
                          {tier.maxQty !== null && (
                            <label className="block space-y-1 text-[11px] text-neutral-400">
                              <span>Maximum quantity</span>
                              <input
                                type="number"
                                value={tier.maxQty}
                                onChange={(e) =>
                                  updateTierRange(tierIdx, "maxQty", e.target.value)
                                }
                                min={tier.minQty}
                                className="min-h-[40px] w-full rounded border border-neutral-600 bg-neutral-800 px-3 py-2 text-sm text-neutral-200"
                                aria-label={`Tier ${tier.tier} max qty`}
                              />
                            </label>
                          )}
                          <div className="flex flex-col gap-2 sm:flex-row">
                            {isLast && (
                              <button
                                type="button"
                                onClick={() => toggleOpenEnded(tierIdx)}
                                className="min-h-[40px] flex-1 rounded border border-neutral-600 bg-neutral-800 px-3 py-2 text-xs font-medium text-neutral-200 hover:bg-neutral-700"
                              >
                                {tier.maxQty === null
                                  ? "Set upper bound"
                                  : "Make open-ended"}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => deleteTier(tierIdx)}
                              className="min-h-[40px] flex-1 rounded border border-red-800 bg-red-950/30 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-900/40"
                              aria-label={`Delete tier ${tier.tier}`}
                            >
                              Delete tier
                            </button>
                          </div>
                        </section>
                      )}
                      {activeLanes.map((lane) => (
                        <div
                          key={lane.key}
                          className="rounded border border-neutral-800 bg-neutral-900 px-2.5 py-2 flex items-start justify-between gap-2"
                        >
                          <div className="text-[11px]">
                            <div className="font-semibold text-neutral-300">{lane.label}</div>
                            <div className="text-[10px] text-neutral-500">
                              Target {Math.round(lane.margin * 100)}% GM
                            </div>
                          </div>
                          <DtfPriceCell
                            cellKey={cellKeyFor(tierIdx, tier, lane.key)}
                            tierLabel={tier.tier}
                            laneKey={lane.key}
                            laneLabel={lane.label}
                            price={tier.prices[lane.key]}
                            basis={tierBasis}
                            roundingIncrement={roundingIncrement}
                            editing={editing}
                            disabled={rollbackInProgress}
                            persistedError={
                              cellErrors[cellKeyFor(tierIdx, tier, lane.key)]
                            }
                            onPriceChange={(value) =>
                              updateTierPrice(tierIdx, lane.key, String(value))
                            }
                            onValidityChange={handleCellValidityChange}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {editing && (
              <button
                onClick={addTier}
                className="min-h-[40px] w-full text-xs px-3 py-2 rounded bg-neutral-800 border border-neutral-700 text-neutral-300 hover:bg-neutral-700"
              >
                + Add Tier
              </button>
            )}
          </div>
        )}
      </div>

      {previewError && (
        <div
          className="rounded-md bg-amber-900/20 border border-amber-700/40 px-3 py-2 text-xs text-amber-300"
          role="status"
        >
          {previewError}
        </div>
      )}

      <DtfQuoteImpact
        inputs={quoteInputs}
        errors={quoteErrors}
        lanes={activeLanes.map((lane) => ({ key: lane.key, label: lane.label }))}
        result={quoteImpact}
        recalculating={recalculating}
        maxQuantity={maxQuantity}
        maxProductCost={MAX_PRODUCT_COST}
        onChange={handleQuoteChange}
      />

      <DtfPricingContext preview={preview} />
      </div>
    </div>
  );
}
