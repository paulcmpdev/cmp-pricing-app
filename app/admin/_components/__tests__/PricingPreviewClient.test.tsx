// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import PricingPreview from "../PricingPreview";

// --- Helpers ---

const DEBOUNCE_MS = 400;

function makeTier(
  tier: string,
  minQty: number,
  maxQty: number,
  prices: Record<string, string> = {}
) {
  const lanes = Object.fromEntries(
    ["T1", "T2", "T3", "T4"].map((lane) => [
      lane,
      {
        currentMargin: "0.50",
        draftMargin: prices[lane] ? "0.55" : "0.50",
        edited: !!prices[lane],
        current: {
          baseDtfCogs: "2.50",
          laborRecovery: "0.30",
          targetMargin: "0.50",
          marginLoadedAmount: "5.00",
          raw: "5.30",
          increment: "0.05",
          final: "5.35",
          achievedMargin: "0.505",
        },
        draft: {
          baseDtfCogs: "2.50",
          laborRecovery: "0.30",
          targetMargin: prices[lane] ? "0.55" : "0.50",
          marginLoadedAmount: prices[lane] ? "5.56" : "5.00",
          raw: prices[lane] ? "5.86" : "5.30",
          increment: "0.05",
          final: prices[lane] || "5.35",
          achievedMargin: prices[lane] ? "0.555" : "0.505",
        },
      },
    ])
  );

  return {
    tier,
    minQty,
    maxQty,
    activeTotalDtfCogs: "2.80",
    baseDtfCogs: "2.50",
    laborRecovery: "0.30",
    lanes,
  };
}

function makePreview(tiers = [makeTier("72-143", 72, 143)]) {
  return {
    schemaVersion: "1.0.0",
    source: "lib/fixtures/pricing-contract.json",
    pricingPolicy: {
      productCostMultiplier: 2,
      commissionReserveRate: 0.08,
      roundingIncrement: "0.05",
    },
    dtfContext: {
      activeProductionMode: "Average",
      pricingMode: "Tier-Based",
      sharedProjectLaborPerOrder: "21.75",
      capturedTransferSizeIn: { width: 10, height: 10 },
      sheetWidthIn: 24,
      spacingIn: 0.25,
    },
    tiers,
  };
}

function makeQuote() {
  return {
    tier: "72-143",
    lane: "T1",
    productCost: "4.80",
    quantity: 174,
    contributionBasis:
      "Internal contribution preview uses active tier COGS as modeled decoration COGS.",
    current: {
      productSell: "9.60",
      decorationSell: "6.00",
      unitPrice: "15.60",
      orderTotal: "2714.40",
      commissionReserve: "1.25",
      modeledDecorationCogs: "3.11",
      totalProductionCogs: "7.91",
      grossProfitBeforeCommission: "7.69",
      netContributionAfterCommission: "6.44",
      contributionMarginAfterCommission: "0.413127351",
      netContributionOrderTotal: "1121.39",
    },
    draft: {
      productSell: "9.60",
      decorationSell: "6.60",
      unitPrice: "16.20",
      orderTotal: "2818.80",
      commissionReserve: "1.30",
      modeledDecorationCogs: "3.11",
      totalProductionCogs: "7.91",
      grossProfitBeforeCommission: "8.29",
      netContributionAfterCommission: "6.99",
      contributionMarginAfterCommission: "0.4314814815",
      netContributionOrderTotal: "1216.26",
    },
    delta: {
      productSell: "0.00",
      decorationSell: "0.60",
      unitPrice: "0.60",
      orderTotal: "104.40",
      orderPercent: "0.0384615385",
      commissionReserve: "0.05",
      grossProfitBeforeCommission: "0.60",
      netContributionAfterCommission: "0.55",
      contributionMarginAfterCommission: "0.0183541305",
      netContributionOrderTotal: "94.87",
    },
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function okResponse(preview: unknown, quote?: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ preview, quote }),
  };
}

function errorResponse(errorBody: Record<string, unknown>, status = 400) {
  return {
    ok: false,
    status,
    json: async () => ({ error: errorBody }),
  };
}

/** Both desktop + mobile render in jsdom. Grab first matching input. */
function firstInput(label: string): HTMLInputElement {
  return screen.getAllByLabelText(label)[0] as HTMLInputElement;
}

/** Change input value via fireEvent (works reliably with fake timers). */
function changeInput(el: HTMLInputElement, value: string) {
  fireEvent.change(el, { target: { value } });
}

/** Render component and wait for initial load to complete. */
async function renderAndLoad(fetchMock: ReturnType<typeof vi.fn>) {
  fetchMock.mockResolvedValueOnce(okResponse(makePreview(), makeQuote()));
  render(<PricingPreview />);
  await waitFor(() => {
    expect(screen.getByText("pricing-contract.json")).toBeInTheDocument();
  });
}

/** Render with fake timers and deferred initial fetch. */
async function renderFakeTimers(fetchMock: ReturnType<typeof vi.fn>) {
  const initD = deferred<unknown>();
  fetchMock.mockReturnValueOnce(initD.promise);
  render(<PricingPreview />);
  await act(async () => {
    initD.resolve(okResponse(makePreview(), makeQuote()));
    await vi.advanceTimersByTimeAsync(1);
  });
  // Ensure render settles
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}

// --- Tests ---

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PricingPreview client component", () => {
  describe("initial load and rendering", () => {
    it("renders schemaVersion in Pricing Context", async () => {
      fetchMock.mockResolvedValue(okResponse(makePreview(), makeQuote()));
      render(<PricingPreview />);
      await waitFor(() => {
        expect(screen.getByText("1.0.0")).toBeInTheDocument();
      });
      expect(screen.getByText("Schema Version")).toBeInTheDocument();
    });

    it("renders baseDtfCogs and laborRecovery as separate desktop columns", async () => {
      fetchMock.mockResolvedValue(okResponse(makePreview(), makeQuote()));
      render(<PricingPreview />);
      await waitFor(() => {
        expect(screen.getByText("Base COGS")).toBeInTheDocument();
      });
      expect(screen.getByText("Labor")).toBeInTheDocument();
      expect(screen.getByText("Total COGS")).toBeInTheDocument();
    });

    it("renders contribution comparison with per-item labels", async () => {
      fetchMock.mockResolvedValue(okResponse(makePreview(), makeQuote()));
      render(<PricingPreview />);
      await waitFor(() => {
        expect(screen.getByText("Contribution Comparison")).toBeInTheDocument();
      });
      expect(
        screen.getAllByText(/Gross Profit \/ Item/).length
      ).toBeGreaterThanOrEqual(1);
      expect(
        screen.getAllByText(/Net Contribution \/ Item/).length
      ).toBeGreaterThanOrEqual(1);
      expect(
        screen.getAllByText(/Contribution Margin/).length
      ).toBeGreaterThanOrEqual(1);
      expect(
        screen.getAllByText(/Net Contribution \/ Order/).length
      ).toBeGreaterThanOrEqual(1);
      expect(
        screen.getAllByText(/Commission \/ Item/).length
      ).toBeGreaterThanOrEqual(1);
      expect(screen.getByText(/commission is per item/i)).toBeInTheDocument();
    });
  });

  describe("stale response prevention", () => {
    it("out-of-order responses: only latest token data is applied", async () => {
      vi.useFakeTimers();

      await renderFakeTimers(fetchMock);

      const slowD = deferred<unknown>();
      const fastD = deferred<unknown>();
      fetchMock.mockReturnValueOnce(slowD.promise);
      fetchMock.mockReturnValueOnce(fastD.promise);

      const input = firstInput("T1 margin for tier 72-143");

      // First edit triggers debounce
      act(() => {
        changeInput(input, "55");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
      });

      // Second edit triggers new debounce
      act(() => {
        changeInput(input, "60");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
      });

      // Resolve second (latest) first
      await act(async () => {
        fastD.resolve(
          okResponse(
            makePreview([makeTier("72-143", 72, 143, { T1: "6.00" })]),
            makeQuote()
          )
        );
        await vi.advanceTimersByTimeAsync(1);
      });

      // Resolve first (stale)
      await act(async () => {
        slowD.resolve(
          okResponse(
            makePreview([makeTier("72-143", 72, 143, { T1: "5.55" })]),
            makeQuote()
          )
        );
        await vi.advanceTimersByTimeAsync(1);
      });

      // Latest ($6.00) shown, stale ($5.55) not
      expect(screen.getAllByText("$6.00").length).toBeGreaterThan(0);
      expect(screen.queryByText("$5.55")).not.toBeInTheDocument();
    });

    it("Reset All clears pending debounce timer", async () => {
      vi.useFakeTimers();
      await renderFakeTimers(fetchMock);

      const input = firstInput("T1 margin for tier 72-143");

      // Edit — don't let debounce fire
      act(() => {
        changeInput(input, "55");
      });

      // Reset All
      const resetD = deferred<unknown>();
      fetchMock.mockReturnValueOnce(resetD.promise);

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: /reset all/i }));
      });

      // Advance past debounce — old edit fetch should NOT fire
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 200);
      });

      // initial(1) + reset(1) = 2 (no stale edit call)
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await act(async () => {
        resetD.resolve(okResponse(makePreview(), makeQuote()));
        await vi.advanceTimersByTimeAsync(1);
      });
    });

    it("Reset All aborts in-flight edit — stale edit never repaints", async () => {
      vi.useFakeTimers();
      await renderFakeTimers(fetchMock);

      // Edit + fire debounce
      const editD = deferred<unknown>();
      fetchMock.mockReturnValueOnce(editD.promise);

      const input = firstInput("T1 margin for tier 72-143");
      act(() => {
        changeInput(input, "55");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
      });

      // Reset — aborts and fires fresh
      const resetD = deferred<unknown>();
      fetchMock.mockReturnValueOnce(resetD.promise);
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: /reset all/i }));
      });

      // Resolve reset
      await act(async () => {
        resetD.resolve(okResponse(makePreview(), makeQuote()));
        await vi.advanceTimersByTimeAsync(1);
      });

      // Late stale edit — must be discarded
      await act(async () => {
        editD.resolve(
          okResponse(
            makePreview([makeTier("72-143", 72, 143, { T1: "5.55" })]),
            makeQuote()
          )
        );
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(screen.queryByText("$5.55")).not.toBeInTheDocument();
    });
  });

  describe("local validation", () => {
    it("invalid margin (100): no POST, inline error, hidden price cell", async () => {
      vi.useFakeTimers();
      await renderFakeTimers(fetchMock);

      const callCountAfterInit = fetchMock.mock.calls.length;
      const input = firstInput("T1 margin for tier 72-143");

      act(() => {
        changeInput(input, "100");
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 200);
      });

      // No additional fetch
      expect(fetchMock.mock.calls.length).toBe(callCountAfterInit);

      // Inline error
      const alerts = screen.getAllByRole("alert");
      expect(alerts.some((a) => a.textContent?.includes("Max 99%"))).toBe(
        true
      );

      // aria-invalid
      expect(input).toHaveAttribute("aria-invalid", "true");

      // Dash instead of price
      const dashes = screen.getAllByLabelText(
        /T1 price for tier 72-143 unavailable/
      );
      expect(dashes.length).toBeGreaterThanOrEqual(1);
    });

    it("invalid margin aborts an in-flight valid edit and blocks its late response", async () => {
      vi.useFakeTimers();
      await renderFakeTimers(fetchMock);

      const editD = deferred<unknown>();
      fetchMock.mockReturnValueOnce(editD.promise);
      const input = firstInput("T1 margin for tier 72-143");

      act(() => {
        changeInput(input, "55");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
      });

      act(() => {
        changeInput(input, "100");
      });

      await act(async () => {
        editD.resolve(
          okResponse(
            makePreview([makeTier("72-143", 72, 143, { T1: "5.55" })]),
            makeQuote()
          )
        );
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(screen.queryByText("$5.55")).not.toBeInTheDocument();
      expect(screen.queryByText("Contribution Comparison")).not.toBeInTheDocument();
      expect(input).toHaveAttribute("aria-invalid", "true");
    });

    it("invalid qty 5001 clears quote, valid margin edit still fires without quote", async () => {
      vi.useFakeTimers();
      await renderFakeTimers(fetchMock);

      // Verify contribution initially shown
      expect(screen.getByText("Contribution Comparison")).toBeInTheDocument();

      // Invalid qty
      const qtyInput = screen.getByLabelText("Quote quantity");
      act(() => {
        changeInput(qtyInput as HTMLInputElement, "5001");
      });

      // Field error shown
      const alerts = screen.getAllByRole("alert");
      expect(alerts.some((a) => a.textContent?.includes("1-5,000"))).toBe(
        true
      );

      // Quote cleared
      expect(
        screen.queryByText("Contribution Comparison")
      ).not.toBeInTheDocument();

      // Margin edit still triggers fetch
      fetchMock.mockResolvedValueOnce(
        okResponse(
          makePreview([makeTier("72-143", 72, 143, { T1: "5.90" })]),
          undefined
        )
      );
      const marginInput = firstInput("T1 margin for tier 72-143");
      act(() => {
        changeInput(marginInput, "55");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
      });

      // POST body should not have quote
      const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
      const body = JSON.parse(lastCall[1].body);
      expect(body.quote).toBeUndefined();
    });
  });

  describe("beforeunload behavior", () => {
    it("sets e.returnValue and preventDefault when dirty", async () => {
      await renderAndLoad(fetchMock);

      // When NOT dirty
      const cleanEvent = new Event("beforeunload", {
        cancelable: true,
      }) as BeforeUnloadEvent;
      let cleanRvSet = false;
      Object.defineProperty(cleanEvent, "returnValue", {
        set: () => {
          cleanRvSet = true;
        },
        get: () => "",
        configurable: true,
      });
      window.dispatchEvent(cleanEvent);
      expect(cleanRvSet).toBe(false);

      // Make dirty
      const input = firstInput("T1 margin for tier 72-143");
      act(() => {
        changeInput(input, "55");
      });

      // When dirty
      const dirtyEvent = new Event("beforeunload", {
        cancelable: true,
      }) as BeforeUnloadEvent;
      let dirtyRvSet = false;
      Object.defineProperty(dirtyEvent, "returnValue", {
        set: () => {
          dirtyRvSet = true;
        },
        get: () => "",
        configurable: true,
      });
      window.dispatchEvent(dirtyEvent);
      expect(dirtyRvSet).toBe(true);
    });
  });

  describe("unmount cleanup", () => {
    it("removes beforeunload listener on unmount", async () => {
      const removeSpy = vi.spyOn(window, "removeEventListener");
      fetchMock.mockResolvedValueOnce(okResponse(makePreview(), makeQuote()));

      const { unmount } = render(<PricingPreview />);
      await waitFor(() => {
        expect(screen.getByText("pricing-contract.json")).toBeInTheDocument();
      });

      unmount();

      const removed = removeSpy.mock.calls.filter(
        (c) => c[0] === "beforeunload"
      );
      expect(removed.length).toBe(1);
    });
  });

  describe("API field error parsing", () => {
    it("clears stale quote data on API field error", async () => {
      vi.useFakeTimers();
      await renderFakeTimers(fetchMock);
      expect(screen.getByText("Contribution Comparison")).toBeInTheDocument();

      // Next fetch returns field error
      fetchMock.mockReturnValueOnce(
        Promise.resolve(
          errorResponse({
            quantity: ["Must be an integer between 1 and 5000."],
          })
        )
      );

      const qtyInput = screen.getByLabelText("Quote quantity");
      act(() => {
        changeInput(qtyInput as HTMLInputElement, "999");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
      });

      // Wait for error to propagate
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });

      expect(
        screen.queryByText("Contribution Comparison")
      ).not.toBeInTheDocument();
    });
  });
});
