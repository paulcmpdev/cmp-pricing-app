"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DtfMatrixPreview,
  DtfPreviewResponse,
  DtfQuoteImpact,
} from "@/lib/pricing/dtf-matrix-preview-types";

export type DtfMatrixDraftConfig = {
  lanes: Array<{ key: string; label: string; margin: number; active: boolean }>;
  tiers: Array<{
    tier: string;
    minQty: number;
    maxQty: number | null;
    prices: Record<string, number>;
  }>;
};

export type QuoteRequest = {
  productCost: number;
  quantity: number;
  lane: string;
};

const DEBOUNCE_MS = 350;

type State = {
  preview: DtfMatrixPreview | null;
  quoteImpact: DtfQuoteImpact | null;
  recalculating: boolean;
  error: string | null;
};

/**
 * Keeps the server-calculated DTF preview (per-tier cost bases, derived
 * DTF GM%, and Quote Impact) in step with the editor's unsaved draft.
 *
 * Two ordering hazards are handled explicitly:
 *
 *  1. Debounce — keystrokes coalesce into one request per `DEBOUNCE_MS`.
 *  2. Stale responses — every request carries a monotonically increasing
 *     token and the previous request is aborted. A response is applied only
 *     when its token is still the newest, so a slow early response can never
 *     repaint over a newer edit. The `finally` block is guarded the same way,
 *     so a late abort cannot clear the spinner for a live request either.
 *
 * The two interact: invalidation happens the moment a newer draft/saved/quote
 * input is *scheduled*, not when its debounce elapses. Otherwise an in-flight
 * response landing inside the 350ms gap would still hold the newest token and
 * repaint the grid with numbers the admin has already typed past.
 *
 * A rejected draft (mid-edit values the API's bounds reject) keeps the last
 * good preview on screen and reports the problem, rather than blanking the
 * grid while the admin is still typing.
 */
export function useDtfMatrixPreview({
  draft,
  saved,
  quote,
  enabled = true,
}: {
  draft: DtfMatrixDraftConfig | null;
  saved: DtfMatrixDraftConfig | null;
  quote: QuoteRequest | null;
  enabled?: boolean;
}): State & { refresh: () => void } {
  const [state, setState] = useState<State>({
    preview: null,
    quoteImpact: null,
    recalculating: false,
    error: null,
  });

  const tokenRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRunRef = useRef(true);

  // Serialize so the effect re-runs on content change, not identity change.
  const draftKey = draft ? JSON.stringify(draft) : null;
  const savedKey = saved ? JSON.stringify(saved) : null;
  const quoteKey = quote ? JSON.stringify(quote) : null;

  /**
   * Retire whatever is in flight: bump the token so its response can no longer
   * pass the freshness checks, and abort the request so it stops costing a
   * connection. Safe to call when nothing is in flight.
   */
  const invalidateInFlight = useCallback(() => {
    tokenRef.current += 1;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const run = useCallback(async () => {
    if (!enabled || !draftKey) return;

    invalidateInFlight();
    const controller = new AbortController();
    abortRef.current = controller;
    const token = ++tokenRef.current;

    setState((prev) => ({ ...prev, recalculating: true }));

    try {
      const res = await fetch("/api/admin/pricing/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          draft: JSON.parse(draftKey),
          ...(savedKey ? { current: JSON.parse(savedKey) } : {}),
          ...(quoteKey ? { quote: JSON.parse(quoteKey) } : {}),
        }),
      });

      if (token !== tokenRef.current) return;

      if (res.status === 404) {
        setState((prev) => ({
          ...prev,
          error: "Pricing preview is disabled in this environment.",
        }));
        return;
      }

      if (!res.ok) {
        // Keep the last good preview: the draft is only momentarily invalid
        // while the admin types, and blanking the grid would be worse.
        setState((prev) => ({
          ...prev,
          error:
            res.status === 400
              ? "Draft is not previewable yet — check tier ranges, lane keys, and prices."
              : `Preview unavailable (HTTP ${res.status}).`,
        }));
        return;
      }

      const data = (await res.json()) as DtfPreviewResponse;
      if (token !== tokenRef.current) return;

      // Defensive: an unexpected payload shape must not wipe a good preview.
      if (!data || !Array.isArray(data.preview?.tiers)) {
        setState((prev) => ({ ...prev, error: "Malformed preview response." }));
        return;
      }

      setState({
        preview: data.preview,
        quoteImpact: data.quote ?? null,
        recalculating: false,
        error: null,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (token !== tokenRef.current) return;
      setState((prev) => ({
        ...prev,
        error: "Failed to reach the pricing preview API.",
      }));
    } finally {
      if (token === tokenRef.current) {
        setState((prev) => ({ ...prev, recalculating: false }));
      }
    }
  }, [enabled, draftKey, savedKey, quoteKey, invalidateInFlight]);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    // Retire the in-flight request here, at schedule time — not inside `run`
    // once the debounce elapses. A response arriving during the gap belongs to
    // inputs the admin has already superseded.
    invalidateInFlight();

    if (!enabled || !draftKey) {
      // Nothing is queued to replace what was just retired, and the aborted
      // request's token-guarded `finally` will not fire for it, so the spinner
      // has to be taken down here.
      setState((prev) =>
        prev.recalculating ? { ...prev, recalculating: false } : prev
      );
      return;
    }

    // The first calculation after the config loads should not sit behind the
    // debounce — the grid has no DTF GM% to show until it lands.
    if (firstRunRef.current) {
      firstRunRef.current = false;
      run();
      return;
    }

    debounceRef.current = setTimeout(run, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [enabled, draftKey, run, invalidateInFlight]);

  // Abort anything in flight on unmount so a late response can't set state
  // on an unmounted component.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
      tokenRef.current += 1;
    };
  }, []);

  /** Force an immediate recalculation, bypassing the debounce. */
  const refresh = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    run();
  }, [run]);

  return { ...state, refresh };
}
