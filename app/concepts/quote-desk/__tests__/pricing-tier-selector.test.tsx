// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import QuoteDeskClient from "../QuoteDeskClient";

// ---------------------------------------------------------------------------
// Pricing Tier (lane) selector — Manager/Admin can override the active
// pricing lane; Sales Reps see the applied default with no control.
//
// Contract assumption: GET /api/quote/options returns an authoritative
// `canOverridePricingLane` boolean alongside dynamic `lanes` (key/label
// pairs). The frontend must never hard-code lane keys/labels and must
// fail closed (no interactive control) when the flag is absent or false.
// ---------------------------------------------------------------------------

const CATALOG = [{ category: "Tees", sku: "TEE-100", name: "Basic Tee" }];

// Deliberately non T1-T4 keys/labels to prove the UI renders whatever the
// server sends rather than a hard-coded set.
const RUSH_LANE = { key: "rush_2026", label: "Rush Production" };
const STANDARD_LANE = { key: "standard_2026", label: "Standard" };

function okJson(data: unknown) {
  return { ok: true, status: 200, json: async () => data };
}

function makeItemQuote(overrides: Record<string, unknown> = {}) {
  return {
    productSell: 5.0,
    decorationSell: 5.0,
    salesPrice: 10.0,
    salesOrderTotal: 840.0,
    tierLabel: "72-143",
    ...overrides,
  };
}

function makeOptionsResponse(overrides: Record<string, unknown> = {}) {
  return {
    lanes: [RUSH_LANE, STANDARD_LANE],
    services: [],
    minimumBillableQuantity: 12,
    ...overrides,
  };
}

function mockFetch(fetchMock: ReturnType<typeof vi.fn>, optionsResponse: unknown) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.includes("/api/quote/options")) {
      return Promise.resolve(okJson(optionsResponse));
    }
    if (typeof url === "string" && url.includes("/api/quote/item")) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return Promise.resolve(
        okJson(makeItemQuote({ tierPriceLaneEcho: body.tierPriceLane }))
      );
    }
    return Promise.resolve(okJson({}));
  });
}

async function renderQuoteDesk(mode: "primary" | "evaluation" = "primary") {
  render(<QuoteDeskClient catalog={CATALOG} mode={mode} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function selectProductAndSettle() {
  fireEvent.change(document.getElementById("product-select")!, {
    target: { value: "TEE-100" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(350);
  });
}

describe("Pricing Tier selector", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows an interactive, accessibly-labeled selector for Manager/Admin using dynamic lane keys/labels", async () => {
    mockFetch(fetchMock, makeOptionsResponse({ canOverridePricingLane: true }));
    await renderQuoteDesk();

    const select = screen.getByLabelText("Pricing Tier") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.disabled).toBe(false);

    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toEqual([RUSH_LANE.label, STANDARD_LANE.label]);
    // Must never hard-code the legacy T1-T4 keys/labels.
    expect(screen.queryByText(/^T[1-4]$/)).toBeNull();
  });

  it("does not render an interactive control for Sales Reps and instead shows the applied default lane", async () => {
    mockFetch(fetchMock, makeOptionsResponse({ canOverridePricingLane: false }));
    await renderQuoteDesk();

    expect(screen.queryByLabelText("Pricing Tier")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Pricing Tier" })).toBeNull();

    // The default (first) lane's label is still communicated, read-only.
    expect(screen.getByTestId("pricing-tier-readonly").textContent).toContain(RUSH_LANE.label);
  });

  it("omits tierPriceLane from Sales Rep item quote requests", async () => {
    mockFetch(fetchMock, makeOptionsResponse({ canOverridePricingLane: false }));
    await renderQuoteDesk("evaluation");
    await selectProductAndSettle();

    const lastItemCall = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/api/quote/item"))
      .pop()!;
    const lastBody = JSON.parse((lastItemCall[1] as RequestInit).body as string);

    expect(lastBody).not.toHaveProperty("tierPriceLane");
  });

  it("fails closed (no interactive control) when canOverridePricingLane is absent from the response", async () => {
    mockFetch(fetchMock, makeOptionsResponse());
    await renderQuoteDesk();

    expect(screen.queryByLabelText("Pricing Tier")).toBeNull();
    expect(screen.getByTestId("pricing-tier-readonly").textContent).toContain(RUSH_LANE.label);
  });

  it("changing the lane invalidates and recalculates the item quote and totals", async () => {
    mockFetch(fetchMock, makeOptionsResponse({ canOverridePricingLane: true }));
    await renderQuoteDesk("evaluation");
    await selectProductAndSettle();

    expect(screen.getByLabelText(/per-item price/i).textContent).toContain("$10.00");
    const itemCallsBefore = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/quote/item")
    ).length;

    fireEvent.change(screen.getByLabelText("Pricing Tier"), {
      target: { value: STANDARD_LANE.key },
    });

    // Stale quote must clear immediately (invalidation), before the
    // debounced recalculation resolves.
    expect(screen.queryByLabelText(/per-item price/i)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });

    const itemCallsAfter = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/quote/item")
    ).length;
    expect(itemCallsAfter).toBeGreaterThan(itemCallsBefore);

    const lastItemCall = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/api/quote/item"))
      .pop()!;
    const lastBody = JSON.parse((lastItemCall[1] as RequestInit).body as string);
    expect(lastBody.tierPriceLane).toBe(STANDARD_LANE.key);

    expect(screen.getByLabelText(/per-item price/i)).not.toBeNull();
  });

  it("refreshes the authoritative capability when local evaluation switches to Manager", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/api/quote/options")) {
        const headers = new Headers(init?.headers);
        const isLocalManager = headers.get("x-cmp-role") === "manager";
        return Promise.resolve(
          okJson(makeOptionsResponse({ canOverridePricingLane: isLocalManager }))
        );
      }
      if (url.includes("/api/quote/item")) {
        return Promise.resolve(okJson(makeItemQuote()));
      }
      return Promise.resolve(okJson({}));
    });

    await renderQuoteDesk("evaluation");
    expect(screen.queryByLabelText("Pricing Tier")).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Toggle Manager mode" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const optionsCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/quote/options")
    );
    expect(optionsCalls).toHaveLength(2);
    expect(new Headers((optionsCalls[1][1] as RequestInit).headers).get("x-cmp-role")).toBe(
      "manager"
    );
    expect(screen.getByLabelText("Pricing Tier")).not.toBeNull();
  });
});
