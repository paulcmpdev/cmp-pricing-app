// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import QuoteDeskClient from "../QuoteDeskClient";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const CATALOG = [{ category: "Tees", sku: "TEE-100", name: "Basic Tee" }];

/** ManagerItemQuote response — salesPrice is always $10 for simplicity. */
function makeItemQuote(qty: number) {
  return {
    productSell: 5.0,
    decorationSell: 5.0,
    salesPrice: 10.0,
    salesOrderTotal: 10.0 * qty,
    tierLabel: "72-143",
    commissionReserve: 10.0 * 0.08,
    totalDecorationCogs: 2.0,
    totalProductionCogs: 5.0,
    grossProfitBeforeCommission: 5.0,
    netContributionAfterCommission: 4.2,
    combinedGrossMarginBeforeCommission: 0.5,
    contributionMarginAfterCommission: 0.42,
    productionCogsOrderTotal: 5.0 * qty,
    netContributionOrderTotal: 4.2 * qty,
  };
}

/** ManagerFlatFeeQuote — effectivePrice varies by qty to detect stale data. */
function makeLocationQuote(qty: number) {
  const effectivePrice = qty === 84 ? 1.25 : qty === 200 ? 0.95 : 1.10;
  const engineCogs = qty === 84 ? 0.65 : qty === 200 ? 0.45 : 0.55;
  return {
    service: "Sleeve Print",
    effectivePrice,
    status: "ok",
    billableQuantity: qty,
    addOnTotal: effectivePrice * qty,
    engineCogs,
    enginePrice: effectivePrice,
    policyFloor: 0.5,
    grossMargin: 0.4,
    operatorOperatingCost: 0.3,
    extraOperatorLabor: 0,
    extraDesignerLabor: 0,
  };
}

function okJson(data: unknown) {
  return { ok: true, status: 200, json: async () => data };
}

function parseCurrency(s: string): number {
  return parseFloat(s.replace(/[$,]/g, ""));
}

// ---------------------------------------------------------------------------
// Fetch router: separates /api/quote/item from /api/quote/flat-fee queues.
// ---------------------------------------------------------------------------

function createFetchRouter(fetchMock: ReturnType<typeof vi.fn>) {
  const itemQ: Deferred<unknown>[] = [];
  const flatFeeQ: Deferred<unknown>[] = [];
  let flatFeeCallCount = 0;

  fetchMock.mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("/api/quote/flat-fee")) {
      flatFeeCallCount++;
      const d = flatFeeQ.shift();
      return d ? d.promise : Promise.resolve(okJson(makeLocationQuote(84)));
    }
    if (typeof url === "string" && url.includes("/api/quote/item")) {
      const d = itemQ.shift();
      return d ? d.promise : Promise.resolve(okJson(makeItemQuote(84)));
    }
    return Promise.resolve(okJson({}));
  });

  return {
    enqueueItem: () => { const d = deferred<unknown>(); itemQ.push(d); return d; },
    enqueueLocation: () => { const d = deferred<unknown>(); flatFeeQ.push(d); return d; },
    get flatFeeCallCount() { return flatFeeCallCount; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("additional-location quantity race condition", () => {
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

  it("clears stale location quotes on rapid quantity change and never mixes old location pricing into final totals", async () => {
    const router = createFetchRouter(fetchMock);

    // ---------------------------------------------------------------
    // 1. Render & establish baseline
    // ---------------------------------------------------------------
    render(
      <QuoteDeskClient
        catalog={CATALOG}
        mode="evaluation"
        additionalLocationsEnabled={true}
      />
    );

    // Select product
    fireEvent.change(document.getElementById("product-select")!, {
      target: { value: "TEE-100" },
    });

    const itemD84 = router.enqueueItem();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => {
      itemD84.resolve(okJson(makeItemQuote(84)));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByLabelText(/per-item price/i)).toHaveTextContent("$10.00");

    // ---------------------------------------------------------------
    // 2. Add location "Sleeve Print", get initial quote ($1.25)
    // ---------------------------------------------------------------
    fireEvent.click(screen.getByTestId("add-location-btn"));
    const locationRow = screen.getByTestId(/^location-row-/);
    fireEvent.change(within(locationRow).getByRole("combobox"), {
      target: { value: "Sleeve Print" },
    });

    const locD84 = router.enqueueLocation();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => {
      locD84.resolve(okJson(makeLocationQuote(84)));
      await vi.advanceTimersByTimeAsync(10);
    });

    // Baseline: $10.00 + $1.25 = $11.25
    expect(screen.getByLabelText(/per-item price/i)).toHaveTextContent("$11.25");
    const baselineFlatFeeCalls = router.flatFeeCallCount;

    // ---------------------------------------------------------------
    // 3. Rapid quantity change: 84 → 100 → 200
    // ---------------------------------------------------------------
    const qtyInput = screen.getByLabelText("Order Quantity");
    fireEvent.change(qtyInput, { target: { value: "100" } });
    fireEvent.change(qtyInput, { target: { value: "200" } });

    // ---------------------------------------------------------------
    // 4. ASSERTION: During debounce, old location quote ($1.25) must
    //    NOT contribute to the final price.
    // ---------------------------------------------------------------
    // BUG BEFORE FIX: stale $11.25 remained visible.
    // CORRECT: item and location quotes clear while recalculation is pending.
    expect(screen.queryByLabelText(/per-item price/i)).not.toBeInTheDocument();

    // ---------------------------------------------------------------
    // 5. Advance past debounce — the single canonical location fetch
    //    should fire for qty=200.
    // ---------------------------------------------------------------
    const itemD200 = router.enqueueItem();
    const locD200 = router.enqueueLocation();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });

    // Only one NEW location fetch should fire (not two for 100+200).
    const newFlatFeeCalls = router.flatFeeCallCount - baselineFlatFeeCalls;
    expect(newFlatFeeCalls).toBe(1);

    // ---------------------------------------------------------------
    // 6. Resolve item and location for qty=200
    // ---------------------------------------------------------------
    await act(async () => {
      itemD200.resolve(okJson(makeItemQuote(200)));
      locD200.resolve(okJson(makeLocationQuote(200)));
      await vi.advanceTimersByTimeAsync(10);
    });

    // ---------------------------------------------------------------
    // 7. Final: $10.00 + $0.95 = $10.95
    // ---------------------------------------------------------------
    const finalPrice = parseCurrency(
      screen.getByLabelText(/per-item price/i).textContent ?? ""
    );
    expect(finalPrice).toBeCloseTo(10.95, 2);

    // COGS breakdown should also reflect qty=200 location COGS ($0.45)
    const cogsSection = screen.getByTestId("cogs-breakdown");
    expect(cogsSection).toHaveTextContent("Sleeve Print COGS");
    expect(cogsSection).toHaveTextContent("$0.45");
  });

  it("old item promise resolving after newer one cannot overwrite current quote", async () => {
    const router = createFetchRouter(fetchMock);

    render(
      <QuoteDeskClient
        catalog={CATALOG}
        mode="evaluation"
        additionalLocationsEnabled={true}
      />
    );

    fireEvent.change(document.getElementById("product-select")!, {
      target: { value: "TEE-100" },
    });

    // First request fires for qty=84
    const itemD84 = router.enqueueItem();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => {
      itemD84.resolve(okJson(makeItemQuote(84)));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByLabelText(/per-item price/i)).toHaveTextContent("$10.00");

    // Change to qty=200, fires new request
    const qtyInput = screen.getByLabelText("Order Quantity");
    fireEvent.change(qtyInput, { target: { value: "200" } });

    const staleItemD = router.enqueueItem();
    const freshItemD = router.enqueueItem();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });

    // Change to qty=300 before staleItemD resolves
    fireEvent.change(qtyInput, { target: { value: "300" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });

    // Resolve qty=300 first (fresh), then qty=200 (stale, out-of-order)
    await act(async () => {
      freshItemD.resolve(okJson(makeItemQuote(300)));
      await vi.advanceTimersByTimeAsync(10);
    });

    // Now stale qty=200 resolves — must NOT overwrite
    await act(async () => {
      staleItemD.resolve(okJson({ ...makeItemQuote(200), salesPrice: 99.99 }));
      await vi.advanceTimersByTimeAsync(10);
    });

    // Price must reflect qty=300, not stale qty=200's $99.99
    const price = parseCurrency(
      screen.getByLabelText(/per-item price/i).textContent ?? ""
    );
    expect(price).not.toBe(99.99);
    expect(price).toBeCloseTo(10.0, 2);
  });

  it("old location promise resolving after newer one cannot overwrite current row quote", async () => {
    const router = createFetchRouter(fetchMock);

    render(
      <QuoteDeskClient
        catalog={CATALOG}
        mode="evaluation"
        additionalLocationsEnabled={true}
      />
    );

    fireEvent.change(document.getElementById("product-select")!, {
      target: { value: "TEE-100" },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    // Add location with Sleeve Print, get baseline
    fireEvent.click(screen.getByTestId("add-location-btn"));
    const locationRow = screen.getByTestId(/^location-row-/);
    fireEvent.change(within(locationRow).getByRole("combobox"), {
      target: { value: "Sleeve Print" },
    });

    const locD84 = router.enqueueLocation();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => {
      locD84.resolve(okJson(makeLocationQuote(84)));
      await vi.advanceTimersByTimeAsync(10);
    });

    // Change qty to 200 — fires new location request
    const qtyInput = screen.getByLabelText("Order Quantity");
    fireEvent.change(qtyInput, { target: { value: "200" } });

    const staleLoc = router.enqueueLocation();
    router.enqueueItem(); // item for qty=200
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });

    // Change qty to 300 before staleLoc resolves
    fireEvent.change(qtyInput, { target: { value: "300" } });

    const freshLoc = router.enqueueLocation();
    router.enqueueItem(); // item for qty=300
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });

    // Resolve fresh (qty=300) first
    await act(async () => {
      freshLoc.resolve(okJson(makeLocationQuote(300)));
      await vi.advanceTimersByTimeAsync(10);
    });

    // Now resolve stale (qty=200) out of order — must NOT overwrite
    const staleQuote = { ...makeLocationQuote(200), effectivePrice: 77.77, engineCogs: 77.77 };
    await act(async () => {
      staleLoc.resolve(okJson(staleQuote));
      await vi.advanceTimersByTimeAsync(10);
    });

    // Location price must NOT be $77.77
    const locPriceEl = within(screen.getByTestId(/^location-row-/)).queryByText("$77.77");
    expect(locPriceEl).not.toBeInTheDocument();
  });

  it("removed location rows cannot be resurrected by late-arriving responses", async () => {
    const router = createFetchRouter(fetchMock);

    render(
      <QuoteDeskClient
        catalog={CATALOG}
        mode="evaluation"
        additionalLocationsEnabled={true}
      />
    );

    fireEvent.change(document.getElementById("product-select")!, {
      target: { value: "TEE-100" },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByLabelText(/per-item price/i)).toHaveTextContent("$10.00");

    // Add location & select service
    fireEvent.click(screen.getByTestId("add-location-btn"));
    const locationRow = screen.getByTestId(/^location-row-/);
    const locationId = locationRow.getAttribute("data-testid")!.replace("location-row-", "");
    fireEvent.change(within(locationRow).getByRole("combobox"), {
      target: { value: "Sleeve Print" },
    });

    const locD = router.enqueueLocation();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });

    // Remove BEFORE response arrives
    fireEvent.click(within(locationRow).getByRole("button", { name: /remove/i }));
    expect(screen.queryByTestId(`location-row-${locationId}`)).not.toBeInTheDocument();

    // Late response
    await act(async () => {
      locD.resolve(okJson(makeLocationQuote(84)));
      await vi.advanceTimersByTimeAsync(10);
    });

    // Row must stay removed
    expect(screen.queryByTestId(`location-row-${locationId}`)).not.toBeInTheDocument();
    expect(parseCurrency(
      screen.getByLabelText(/per-item price/i).textContent ?? ""
    )).toBeCloseTo(10.0, 2);
  });

  it("decimal quantity clears populated item and location quotes without firing invalid requests", async () => {
    const router = createFetchRouter(fetchMock);

    render(
      <QuoteDeskClient
        catalog={CATALOG}
        mode="evaluation"
        additionalLocationsEnabled={true}
      />
    );

    fireEvent.change(document.getElementById("product-select")!, {
      target: { value: "TEE-100" },
    });

    const itemD84 = router.enqueueItem();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => {
      itemD84.resolve(okJson(makeItemQuote(84)));
      await vi.advanceTimersByTimeAsync(10);
    });

    fireEvent.click(screen.getByTestId("add-location-btn"));
    const locationRow = screen.getByTestId(/^location-row-/);
    fireEvent.change(within(locationRow).getByRole("combobox"), {
      target: { value: "Sleeve Print" },
    });

    const locD84 = router.enqueueLocation();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => {
      locD84.resolve(okJson(makeLocationQuote(84)));
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(screen.getByLabelText(/per-item price/i)).toHaveTextContent("$11.25");
    const callsBeforeInvalid = fetchMock.mock.calls.length;

    fireEvent.change(screen.getByLabelText("Order Quantity"), {
      target: { value: "12.5" },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });

    expect(screen.queryByLabelText(/per-item price/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("cogs-breakdown")).not.toBeInTheDocument();
    expect(within(locationRow).queryByText(/\$/)).not.toBeInTheDocument();
    expect(screen.getByText("Quantity must be a whole number.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeInvalid);
  });

  it("blank quantity clears populated totals and valid recovery recalculates item and locations", async () => {
    const router = createFetchRouter(fetchMock);

    render(
      <QuoteDeskClient
        catalog={CATALOG}
        mode="evaluation"
        additionalLocationsEnabled={true}
      />
    );

    fireEvent.change(document.getElementById("product-select")!, {
      target: { value: "TEE-100" },
    });

    const itemD84 = router.enqueueItem();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => {
      itemD84.resolve(okJson(makeItemQuote(84)));
      await vi.advanceTimersByTimeAsync(10);
    });

    fireEvent.click(screen.getByTestId("add-location-btn"));
    const locationRow = screen.getByTestId(/^location-row-/);
    fireEvent.change(within(locationRow).getByRole("combobox"), {
      target: { value: "Sleeve Print" },
    });

    const locD84 = router.enqueueLocation();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => {
      locD84.resolve(okJson(makeLocationQuote(84)));
      await vi.advanceTimersByTimeAsync(10);
    });

    fireEvent.change(screen.getByLabelText("Order Quantity"), {
      target: { value: "" },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });

    expect(screen.queryByLabelText(/per-item price/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/order total/i)).not.toBeInTheDocument();
    expect(within(locationRow).queryByText(/\$/)).not.toBeInTheDocument();

    const itemD200 = router.enqueueItem();
    const locD200 = router.enqueueLocation();
    fireEvent.change(screen.getByLabelText("Order Quantity"), {
      target: { value: "200" },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => {
      itemD200.resolve(okJson(makeItemQuote(200)));
      locD200.resolve(okJson(makeLocationQuote(200)));
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(screen.getByLabelText(/per-item price/i)).toHaveTextContent("$10.95");
    expect(screen.getByLabelText(/order total/i)).toHaveTextContent("$2,190.00");
  });
});
