// @vitest-environment jsdom
//
// Behaviour of the unified DTF matrix: one grid that owns structure,
// direct price, DTF GM%, calculation context, and Quote Impact.

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import DtfMatrixEditor from "../DtfMatrixEditor";

// Deliberately round numbers so every expected price is checkable by hand:
//   price  = 3 / (1 - margin) + 0.50, rounded UP to $0.05
//   margin = 1 - 3 / (price - 0.50)
const BASIS = {
  baseDtfCogs: "3",
  laborRecovery: "0.5",
  totalDtfCogs: "3.5",
  costingQty: 13,
  basis: "Worst-case pooled base decoration across qty 12-23 (qty 13) + project labor / 1 at cost",
  source: "engine" as const,
};

const dtfConfig = {
  lanes: [
    { key: "T1", label: "T1", margin: 0.5, active: true },
    { key: "T2", label: "T2", margin: 0.45, active: true },
  ],
  tiers: [{ tier: "1+", minQty: 1, maxQty: null, prices: { T1: 6.5, T2: 6 } }],
};

function previewPayload(quote?: unknown) {
  return {
    preview: {
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
        sharedProjectLaborPerOrder: "36.52",
        capturedTransferSizeIn: { width: 10, height: 10 },
        sheetWidthIn: 22,
        spacingIn: 0.25,
        maxSupportedQuantity: 5000,
      },
      costBases: { "1:+": BASIS, "1:100": BASIS, "101:+": BASIS },
      tiers: [
        {
          tier: "1+",
          minQty: 1,
          maxQty: null,
          costKey: "1:+",
          costBasis: BASIS,
          lanes: {
            T1: {
              price: "6.50",
              margin: "0.5",
              marginPercent: "50",
              belowCost: false,
              error: null,
            },
            T2: {
              price: "6.00",
              margin: "0.4545454545",
              marginPercent: "45.45454545",
              belowCost: false,
              error: null,
            },
          },
        },
      ],
    },
    ...(quote ? { quote } : {}),
  };
}

function quotePayload(draftUnitPrice: string, orderTotal: string) {
  return {
    available: true,
    quantity: 174,
    productCost: "4.80",
    lane: "T1",
    contributionBasis: "Modeled decoration COGS is the draft tier's resolved cost basis.",
    costBasis: BASIS,
    draft: {
      tier: "1+",
      productSell: "9.60",
      decorationSell: draftUnitPrice,
      unitPrice: draftUnitPrice,
      orderTotal,
      commissionReserve: "1.29",
      modeledDecorationCogs: "3.50",
      totalProductionCogs: "8.30",
      grossProfitBeforeCommission: "7.80",
      netContributionAfterCommission: "6.51",
      contributionMarginAfterCommission: "0.4",
      netContributionOrderTotal: "1132.74",
    },
    current: {
      tier: "1+",
      productSell: "9.60",
      decorationSell: "6.50",
      unitPrice: "16.10",
      orderTotal: "2801.40",
      commissionReserve: "1.29",
      modeledDecorationCogs: "3.50",
      totalProductionCogs: "8.30",
      grossProfitBeforeCommission: "7.80",
      netContributionAfterCommission: "6.51",
      contributionMarginAfterCommission: "0.4",
      netContributionOrderTotal: "1132.74",
    },
    currentUnavailableReason: null,
    delta: {
      productSell: "0.00",
      decorationSell: "1.00",
      unitPrice: "1.00",
      orderTotal: "174.00",
      orderPercent: "0.062",
      commissionReserve: "0.08",
      grossProfitBeforeCommission: "1.00",
      netContributionAfterCommission: "0.92",
      contributionMarginAfterCommission: "0.01",
      netContributionOrderTotal: "160.08",
    },
  };
}

function okJson(data: unknown) {
  return { ok: true, status: 200, json: async () => data };
}

type FetchCall = { url: string; body: unknown };

/**
 * Routes by URL so config GETs and preview POSTs never share a counter —
 * these are independent request streams and conflating them hides races.
 */
function mockRoutedFetch(options?: {
  quote?: unknown;
  config?: {
    lanes: typeof dtfConfig.lanes;
    tiers: Array<{
      tier: string;
      minQty: number;
      maxQty: number | null;
      prices: Record<string, number>;
    }>;
  };
  onPreview?: (body: unknown) => Promise<unknown> | undefined;
}) {
  const calls: FetchCall[] = [];
  globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });

    if (String(url).includes("/api/admin/pricing/preview")) {
      const custom = options?.onPreview?.(body);
      if (custom) return custom;
      return Promise.resolve(okJson(previewPayload(options?.quote)));
    }
    return Promise.resolve(
      okJson({ data: options?.config ?? dtfConfig, version: null, source: "baseline" })
    );
  }) as unknown as typeof fetch;
  return calls;
}

const previewCalls = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.includes("/api/admin/pricing/preview"));

// Config GETs carry no body; only the save PUT does.
const saveCalls = (calls: FetchCall[]) =>
  calls.filter(
    (c) =>
      c.url.includes("/api/admin/pricing/config") &&
      (c.body as { configType?: string } | undefined)?.configType === "dtf_matrix"
  );

async function renderEditing(calls = mockRoutedFetch()) {
  render(<DtfMatrixEditor persistenceEnabled />);
  await screen.findByRole("heading", { name: "DTF Pricing Matrix" });
  // A dispatched preview request is not a painted one. The derived GM% needs
  // the cost basis from the response, so waiting on the derived value is what
  // proves the preview has landed *and* been applied — enter edit mode any
  // earlier and the GM% column is still "GM --"/disabled. The table and the
  // Quantity Inspector both show this read-only value pre-edit, so scope to
  // the table to keep the query unambiguous.
  await within(screen.getByTestId("dtf-matrix-table-panel")).findByText(
    "GM 50.0%",
    undefined,
    { timeout: 3000 }
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));
  return calls;
}

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  Object.defineProperty(window, "innerWidth", { value: 1280, writable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("paired price / DTF GM% cells", () => {
  it("shows price and derived DTF GM% together in read-only mode", async () => {
    mockRoutedFetch();
    render(<DtfMatrixEditor persistenceEnabled />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });

    // The price comes straight from the config, so it is on screen before any
    // preview lands and cannot gate this assertion. The GM% is the pairing
    // being asserted and only exists once the preview's cost basis applies.
    // Both the matrix table and the Quantity Inspector show the same
    // read-only value for the selected row, so scope to the table.
    const table = screen.getByTestId("dtf-matrix-table-panel");
    expect(
      await within(table).findByText("GM 50.0%", undefined, { timeout: 3000 })
    ).toBeVisible();
    expect(within(table).getByText("$6.50")).toBeVisible();
  });

  it("labels both fields distinctly for screen readers and mobile input", async () => {
    await renderEditing();

    const price = await screen.findByLabelText("Tier 1+ T1 price");
    const margin = await screen.findByLabelText("Tier 1+ T1 DTF GM percent");

    expect(price).toHaveValue(6.5);
    expect(margin).toHaveValue(50);
    // Distinct controls, not one field doing double duty.
    expect(price).not.toBe(margin);
    // Both are described by the same explanatory note.
    expect(price.getAttribute("aria-describedby")).toBe(
      margin.getAttribute("aria-describedby")
    );
    expect(price).toHaveAttribute("type", "number");
    expect(margin).toHaveAttribute("type", "number");
  });

  it("does not label post-commission contribution as the lane margin", async () => {
    await renderEditing(
      mockRoutedFetch({ quote: quotePayload("17.10", "2975.40") })
    );
    await waitFor(() =>
      expect(screen.getByTestId("dtf-quote-impact-result")).toBeVisible()
    );

    expect(screen.getByText("Post-Commission Contribution Margin")).toBeVisible();
    expect(screen.getAllByText(/DTF GM%/).length).toBeGreaterThan(0);
  });
});

describe("floating-point noise in the config price", () => {
  it("shows a clean price while keeping the margin derived from the real value", async () => {
    // Upstream $0.05-increment rounding can leave a config price like this
    // instead of an exact 6.55. The input must not echo the noise back.
    const noisyConfig = {
      ...dtfConfig,
      tiers: [
        {
          tier: "1+",
          minQty: 1,
          maxQty: null,
          prices: { T1: 6.550000000000001, T2: 6 },
        },
      ],
    };
    globalThis.fetch = vi.fn((url: string) => {
      if (String(url).includes("/api/admin/pricing/preview")) {
        return Promise.resolve(okJson(previewPayload()));
      }
      return Promise.resolve(
        okJson({ data: noisyConfig, version: null, source: "baseline" })
      );
    }) as unknown as typeof fetch;

    render(<DtfMatrixEditor persistenceEnabled />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });
    // net = 6.55 - 0.50 = 6.05; margin = (6.05 - 3) / 6.05 = 50.4%
    await within(screen.getByTestId("dtf-matrix-table-panel")).findByText(
      "GM 50.4%",
      undefined,
      { timeout: 3000 }
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));

    const price = await screen.findByLabelText("Tier 1+ T1 price");
    expect(price).toHaveValue(6.55);
    expect(screen.getByLabelText("Tier 1+ T1 DTF GM percent")).toHaveValue(50.4);
  });
});

describe("editing direct price", () => {
  it("recalculates the displayed DTF GM% as the price changes", async () => {
    await renderEditing();
    const price = await screen.findByLabelText("Tier 1+ T1 price");

    // net = 8.50 - 0.50 = 8.00; margin = (8 - 3) / 8 = 62.5%
    fireEvent.change(price, { target: { value: "8.50" } });

    await waitFor(() =>
      expect(screen.getByLabelText("Tier 1+ T1 DTF GM percent")).toHaveValue(62.5)
    );
  });

  it("shows an inline error instead of NaN when the price cannot cover labor", async () => {
    await renderEditing();
    const price = await screen.findByLabelText("Tier 1+ T1 price");

    fireEvent.change(price, { target: { value: "0.25" } });

    const error = await screen.findByText(/at-cost labor recovery/i);
    expect(error).toBeVisible();
    expect(screen.getByLabelText("Tier 1+ T1 DTF GM percent")).toHaveValue(null);
  });

  it("flags a price that covers labor but not base COGS as below cost", async () => {
    await renderEditing();
    fireEvent.change(screen.getByLabelText("Tier 1+ T1 price"), {
      target: { value: "2.50" },
    });

    // net = 2.00, base = 3.00 -> negative margin, not an exception.
    await waitFor(() => expect(screen.getByText("Below COGS")).toBeVisible());
  });
});

describe("editing DTF GM%", () => {
  it("recalculates the direct price using the labor-at-cost formula", async () => {
    await renderEditing();
    const margin = await screen.findByLabelText("Tier 1+ T1 DTF GM percent");

    // 3 / (1 - 0.40) + 0.50 = 5.50, already on the $0.05 grid.
    fireEvent.change(margin, { target: { value: "40" } });

    await waitFor(() =>
      expect(screen.getByLabelText("Tier 1+ T1 price")).toHaveValue(5.5)
    );
  });

  it("rounds the resulting price UP to the configured $0.05 increment", async () => {
    await renderEditing();
    const margin = await screen.findByLabelText("Tier 1+ T1 DTF GM percent");

    // 3 / 0.55 + 0.50 = 5.9545...; rounded UP to $0.05 -> 6.00
    fireEvent.change(margin, { target: { value: "45" } });

    await waitFor(() =>
      expect(screen.getByLabelText("Tier 1+ T1 price")).toHaveValue(6)
    );
  });

  it("rejects an out-of-range margin inline and leaves the price untouched", async () => {
    await renderEditing();
    const margin = await screen.findByLabelText("Tier 1+ T1 DTF GM percent");

    fireEvent.change(margin, { target: { value: "100" } });

    expect(await screen.findByText(/less than 100%/i)).toBeVisible();
    expect(screen.getByLabelText("Tier 1+ T1 price")).toHaveValue(6.5);
    expect(margin).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps the typed margin while working and snaps to the achieved margin on blur", async () => {
    await renderEditing();
    const margin = await screen.findByLabelText("Tier 1+ T1 DTF GM percent");

    fireEvent.change(margin, { target: { value: "45" } });
    // Still showing what the admin typed, not the rounding-up side effect.
    expect(margin).toHaveValue(45);

    fireEvent.blur(margin);
    // price 6.00 -> net 5.50 -> margin (5.50 - 3) / 5.50 = 45.45%
    await waitFor(() => expect(margin).toHaveValue(45.5));
  });

  it("reports which field drove the last calculation", async () => {
    await renderEditing();

    fireEvent.change(screen.getByLabelText("Tier 1+ T1 DTF GM percent"), {
      target: { value: "40" },
    });
    expect(await screen.findByText("from GM%")).toBeVisible();

    fireEvent.change(screen.getByLabelText("Tier 1+ T1 price"), {
      target: { value: "7.00" },
    });
    expect(await screen.findByText("from price")).toBeVisible();
  });
});

describe("save eligibility with an invalid cell input", () => {
  it("persists invalid GM text across quantity selection and responsive remounts", async () => {
    await renderEditing();

    fireEvent.change(screen.getByLabelText("Tier 1+ T2 price"), {
      target: { value: "7.00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Manage Quantities" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add Tier" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Tier 1+ T1 DTF GM percent")).toBeEnabled()
    );

    const originalMargin = screen.getByLabelText("Tier 1+ T1 DTF GM percent");
    fireEvent.change(originalMargin, { target: { value: "100" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled()
    );

    fireEvent.click(screen.getByRole("button", { name: "Select quantity 101+" }));
    expect(screen.queryByLabelText("Tier 1+ T1 DTF GM percent")).not.toBeInTheDocument();
    expect(screen.getByTestId("dtf-cell-input-errors")).toHaveTextContent("Tier 1+ · T1");
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Select quantity 1+" }));
    const restored = screen.getByLabelText("Tier 1+ T1 DTF GM percent");
    expect(restored).toHaveValue(100);
    expect(restored).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/less than 100%/i)).toBeVisible();

    await act(async () => {
      window.innerWidth = 500;
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getAllByLabelText("Tier 1+ T1 DTF GM percent")).toHaveLength(1);
    expect(screen.getByLabelText("Tier 1+ T1 DTF GM percent")).toHaveValue(100);
    expect(screen.getByLabelText("Tier 1+ T1 DTF GM percent")).toHaveAttribute(
      "aria-invalid",
      "true"
    );

    await act(async () => {
      window.innerWidth = 1280;
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getAllByLabelText("Tier 1+ T1 DTF GM percent")).toHaveLength(1);
    expect(screen.getByLabelText("Tier 1+ T1 DTF GM percent")).toHaveValue(100);

    fireEvent.change(screen.getByLabelText("Tier 1+ T1 DTF GM percent"), {
      target: { value: "40" },
    });
    await waitFor(() =>
      expect(screen.queryByTestId("dtf-cell-input-errors")).not.toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
  });

  it("blocks Save while a typed DTF GM% is invalid, even though the price is still valid", async () => {
    const calls = await renderEditing();

    // A valid edit elsewhere makes the draft dirty, so Save is eligible on
    // every count except the bad cell input.
    fireEvent.change(screen.getByLabelText("Tier 1+ T2 price"), {
      target: { value: "7.00" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled()
    );

    fireEvent.change(screen.getByLabelText("Tier 1+ T1 DTF GM percent"), {
      target: { value: "100" },
    });

    // The rejected GM% left the price at its prior valid value, so nothing in
    // the draft itself signals a problem — only the cell knows.
    expect(screen.getByLabelText("Tier 1+ T1 price")).toHaveValue(6.5);

    const save = screen.getByRole("button", { name: "Save Changes" });
    await waitFor(() => expect(save).toBeDisabled());

    const banner = screen.getByTestId("dtf-cell-input-errors");
    expect(banner).toBeVisible();
    expect(banner).toHaveTextContent("Tier 1+ · T1");

    // handleSave guards independently of the button's disabled state.
    fireEvent.click(save);
    await act(async () => {});
    expect(saveCalls(calls)).toHaveLength(0);
  });

  it("keeps an invalid DTF GM% and its Save block after the field is tabbed out of", async () => {
    const calls = await renderEditing();

    fireEvent.change(screen.getByLabelText("Tier 1+ T2 price"), {
      target: { value: "7.00" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled()
    );

    const margin = screen.getByLabelText("Tier 1+ T1 DTF GM percent");
    fireEvent.change(margin, { target: { value: "100" } });
    expect(await screen.findByText(/less than 100%/i)).toBeVisible();

    // Blur is where the cell normally discards the typed text and snaps to the
    // achieved margin. It must not do that for a value it rejected: snapping
    // would erase both the visible 100 and the error gating Save.
    fireEvent.blur(margin);

    expect(margin).toHaveValue(100);
    expect(margin).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/less than 100%/i)).toBeVisible();
    expect(screen.getByTestId("dtf-cell-input-errors")).toHaveTextContent(
      "Tier 1+ · T1"
    );

    const save = screen.getByRole("button", { name: "Save Changes" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    await act(async () => {});
    expect(saveCalls(calls)).toHaveLength(0);

    // Correcting it after the blur still clears the block.
    // 3 / 0.55 + 0.50 = 5.9545...; rounded UP to $0.05 -> 6.00
    fireEvent.change(margin, { target: { value: "45" } });
    await waitFor(() =>
      expect(screen.getByLabelText("Tier 1+ T1 price")).toHaveValue(6)
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled()
    );
    expect(screen.queryByTestId("dtf-cell-input-errors")).not.toBeInTheDocument();

    // ...and a valid value still snaps to the achieved margin on blur.
    fireEvent.blur(margin);
    await waitFor(() => expect(margin).toHaveValue(45.5));

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(saveCalls(calls)).toHaveLength(1));
  });

  it("restores save eligibility once the DTF GM% is corrected", async () => {
    const calls = await renderEditing();

    fireEvent.change(screen.getByLabelText("Tier 1+ T2 price"), {
      target: { value: "7.00" },
    });
    const margin = screen.getByLabelText("Tier 1+ T1 DTF GM percent");

    fireEvent.change(margin, { target: { value: "100" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled()
    );

    // 3 / (1 - 0.40) + 0.50 = 5.50 — a real price change, so the draft is dirty.
    fireEvent.change(margin, { target: { value: "40" } });
    await waitFor(() =>
      expect(screen.getByLabelText("Tier 1+ T1 price")).toHaveValue(5.5)
    );

    const save = screen.getByRole("button", { name: "Save Changes" });
    await waitFor(() => expect(save).toBeEnabled());
    expect(screen.queryByTestId("dtf-cell-input-errors")).not.toBeInTheDocument();

    fireEvent.click(save);
    await waitFor(() => expect(saveCalls(calls)).toHaveLength(1));
    const body = saveCalls(calls)[0].body as { data: typeof dtfConfig };
    expect(body.data.tiers[0].prices.T1).toBe(5.5);
  });

  it("drops a cell input error when the cell it belongs to goes away", async () => {
    await renderEditing();

    fireEvent.change(screen.getByLabelText("Tier 1+ T1 DTF GM percent"), {
      target: { value: "100" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("dtf-cell-input-errors")).toBeVisible()
    );

    fireEvent.click(screen.getByRole("button", { name: "Manage Lanes" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete lane T1" }));

    await waitFor(() =>
      expect(screen.queryByTestId("dtf-cell-input-errors")).not.toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
  });

  it("drops a cell input error when the draft edit is cancelled", async () => {
    await renderEditing();

    fireEvent.change(screen.getByLabelText("Tier 1+ T1 DTF GM percent"), {
      target: { value: "100" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("dtf-cell-input-errors")).toBeVisible()
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));

    expect(screen.queryByTestId("dtf-cell-input-errors")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Tier 1+ T1 DTF GM percent")).toHaveValue(50);
  });
});

describe("structure controls are preserved", () => {
  it("keeps add/delete/edit controls for quantity tiers", async () => {
    await renderEditing();
    fireEvent.click(screen.getByRole("button", { name: "Manage Quantities" }));

    fireEvent.change(screen.getByLabelText("Tier 1 label"), {
      target: { value: "Starter" },
    });
    expect(screen.getByDisplayValue("Starter")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "+ Add Tier" }));
    expect(screen.getByDisplayValue("101+")).toBeVisible();
    expect(screen.getByLabelText("Tier Starter max qty")).toHaveValue(100);

    fireEvent.click(screen.getByRole("button", { name: "Delete tier 101+" }));
    expect(screen.queryByDisplayValue("101+")).not.toBeInTheDocument();
  });

  it("keeps desktop row keyboard handling on the named selection button", async () => {
    await renderEditing();

    const select = screen.getByRole("button", { name: "Select quantity 1+" });
    const row = select.closest("tr");

    expect(row).not.toHaveAttribute("tabindex");
    expect(select).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Manage Quantities" }));
    const label = screen.getByLabelText("Tier 1 label");
    expect(fireEvent.keyDown(label, { key: " " })).toBe(true);
    expect(fireEvent.keyDown(label, { key: "Enter" })).toBe(true);

    fireEvent.change(label, { target: { value: "Starter Tier" } });
    expect(label).toHaveValue("Starter Tier");
    expect(
      screen.getByRole("button", { name: "Select quantity Starter Tier" })
    ).toBeVisible();
  });

  it("keeps add/delete/rename and active toggles for pricing lanes", async () => {
    await renderEditing();
    fireEvent.click(screen.getByRole("button", { name: "Manage Lanes" }));

    fireEvent.change(screen.getByLabelText("Lane T2 label"), {
      target: { value: "Team" },
    });
    expect(screen.getByDisplayValue("Team")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "+ Add Lane" }));
    expect(screen.getByLabelText("Lane T3 margin percent")).toBeVisible();
    // A new lane is seeded from the previous lane, not $0, so it is priceable.
    expect(screen.getByLabelText("Tier 1+ T3 price")).toHaveValue(6);

    const activeToggles = screen.getAllByRole("checkbox", { name: /Active/ });
    expect(activeToggles[0]).toBeChecked();
    fireEvent.click(activeToggles[0]);
    await waitFor(() =>
      expect(screen.queryByLabelText("Tier 1+ T1 price")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete lane Team" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Lane T2 label")).not.toBeInTheDocument()
    );
  });

  it("shows each tier's cost basis and its source", async () => {
    const calls = mockRoutedFetch();
    render(<DtfMatrixEditor persistenceEnabled />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });
    await waitFor(() => expect(previewCalls(calls).length).toBeGreaterThan(0));

    const basisCell = await screen.findByTestId("dtf-tier-basis-1+");
    expect(basisCell).toHaveTextContent("engine");
    expect(basisCell).toHaveTextContent("q13");
    expect(basisCell).toHaveAttribute("title", BASIS.basis);
  });

  it("disables DTF GM% for a tier whose cost basis is not resolved yet", async () => {
    await renderEditing();
    fireEvent.click(screen.getByRole("button", { name: "Manage Quantities" }));

    // Re-spanning the tier changes its cost key; the cached basis no longer
    // applies, so GM% must degrade to disabled rather than guess.
    fireEvent.change(screen.getByLabelText("Tier 1+ min qty"), {
      target: { value: "5" },
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Tier 1+ T1 DTF GM percent")).toBeDisabled()
    );
  });
});

describe("Quote Impact", () => {
  it("sends the unsaved draft, not the saved config, for comparison", async () => {
    const calls = await renderEditing();

    fireEvent.change(screen.getByLabelText("Tier 1+ T1 price"), {
      target: { value: "7.50" },
    });

    await waitFor(() => {
      const latest = previewCalls(calls).at(-1) as FetchCall;
      const body = latest.body as {
        draft: typeof dtfConfig;
        current: typeof dtfConfig;
        quote: { lane: string; quantity: number };
      };
      expect(body.draft.tiers[0].prices.T1).toBe(7.5);
      expect(body.current.tiers[0].prices.T1).toBe(6.5);
      expect(body.quote.lane).toBe("T1");
    });
  });

  it("reacts to a DTF GM% edit through the resulting price", async () => {
    const calls = await renderEditing();

    fireEvent.change(screen.getByLabelText("Tier 1+ T1 DTF GM percent"), {
      target: { value: "40" },
    });

    await waitFor(() => {
      const latest = previewCalls(calls).at(-1) as FetchCall;
      const body = latest.body as { draft: typeof dtfConfig };
      // The margin edit reaches Quote Impact as the price it produced.
      expect(body.draft.tiers[0].prices.T1).toBe(5.5);
    });
  });

  it("renders the saved-versus-draft comparison", async () => {
    mockRoutedFetch({ quote: quotePayload("17.10", "2975.40") });
    render(<DtfMatrixEditor persistenceEnabled />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });

    const panel = await screen.findByTestId("dtf-quote-impact-result");
    expect(within(panel).getByText("Saved")).toBeVisible();
    expect(within(panel).getByText("Draft")).toBeVisible();
    expect(within(panel).getByText("$2,975.40")).toBeVisible();
    expect(within(panel).getByText("$2,801.40")).toBeVisible();
    expect(within(panel).getByText(/Order delta: \+\$174\.00/)).toBeVisible();
  });

  it("recalculates when the quote inputs change", async () => {
    const calls = await renderEditing();

    fireEvent.change(screen.getByLabelText("Quantity"), {
      target: { value: "500" },
    });

    await waitFor(() => {
      const latest = previewCalls(calls).at(-1) as FetchCall;
      const body = latest.body as { quote: { quantity: number } };
      expect(body.quote.quantity).toBe(500);
    });
  });

  it("validates quote inputs inline and stops sending an invalid quote", async () => {
    const calls = await renderEditing();
    const before = previewCalls(calls).length;

    fireEvent.change(screen.getByLabelText("Quantity"), {
      target: { value: "99999" },
    });

    expect(await screen.findByText(/Whole number 1-5,000/)).toBeVisible();
    await waitFor(() => {
      const after = previewCalls(calls);
      expect(after.length).toBeGreaterThan(before);
      expect((after.at(-1)!.body as { quote?: unknown }).quote).toBeUndefined();
    });
  });

  it("rejects a product cost above the preview API's 100,000 bound inline", async () => {
    const calls = await renderEditing();
    const cost = screen.getByLabelText("Product Cost");
    expect(cost).toHaveAttribute("max", "100000");

    // At the bound the quote is still sent — the client must not be stricter
    // than DtfQuoteInputSchema, which accepts exactly 100000.
    fireEvent.change(cost, { target: { value: "100000" } });
    await waitFor(() => {
      const body = previewCalls(calls).at(-1)!.body as {
        quote?: { productCost: number };
      };
      expect(body.quote?.productCost).toBe(100000);
    });

    const before = previewCalls(calls).length;
    fireEvent.change(cost, { target: { value: "100000.01" } });

    expect(await screen.findByText(/Enter a cost of 0-100,000\./)).toBeVisible();
    expect(cost).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => {
      const after = previewCalls(calls);
      expect(after.length).toBeGreaterThan(before);
      expect((after.at(-1)!.body as { quote?: unknown }).quote).toBeUndefined();
    });
  });
});

describe("preview response ordering", () => {
  it("never lets a stale preview response overwrite a newer edit", async () => {
    const deferred: Array<(value: unknown) => void> = [];
    let previewCount = 0;

    const calls = mockRoutedFetch({
      onPreview: () => {
        previewCount += 1;
        // Calls 1 and 3 resolve immediately; call 2 is held open so it can
        // land *after* call 3 and try to repaint stale numbers.
        if (previewCount === 2) {
          return new Promise((resolve) => deferred.push(resolve));
        }
        return Promise.resolve(
          okJson(
            previewPayload(
              quotePayload(
                previewCount === 1 ? "16.10" : "19.10",
                previewCount === 1 ? "2801.40" : "3323.40"
              )
            )
          )
        );
      },
    });

    render(<DtfMatrixEditor persistenceEnabled />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });
    await waitFor(() => expect(previewCount).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));

    // Edit #1 -> preview call 2 (held open).
    fireEvent.change(screen.getByLabelText("Tier 1+ T1 price"), {
      target: { value: "7.50" },
    });
    await waitFor(() => expect(previewCount).toBe(2), { timeout: 3000 });

    // Edit #2 -> preview call 3, which resolves right away.
    fireEvent.change(screen.getByLabelText("Tier 1+ T1 price"), {
      target: { value: "9.50" },
    });
    await waitFor(() => expect(previewCount).toBe(3), { timeout: 3000 });
    await waitFor(() => expect(screen.getByText("$3,323.40")).toBeVisible());

    // The stale call 2 finally lands with the older numbers.
    deferred[0](okJson(previewPayload(quotePayload("17.10", "2975.40"))));

    await waitFor(() =>
      expect(screen.queryByText("$2,975.40")).not.toBeInTheDocument()
    );
    expect(screen.getByText("$3,323.40")).toBeVisible();
    // The newest edit is intact in the grid too.
    expect(screen.getByLabelText("Tier 1+ T1 price")).toHaveValue(9.5);
    expect(previewCalls(calls).length).toBe(3);
  });

  it("invalidates the in-flight request as soon as a newer edit is scheduled", async () => {
    // The gap this covers: an edit only *schedules* the next request, 350ms
    // out. If invalidation waited for that timer, a response landing inside
    // the gap would still hold the newest token and repaint numbers the admin
    // has already typed past.
    const deferred: Array<(value: unknown) => void> = [];
    let previewCount = 0;

    mockRoutedFetch({
      onPreview: () => {
        previewCount += 1;
        // Call 1 settles immediately so there is a known-good painted state.
        if (previewCount === 1) {
          return Promise.resolve(
            okJson(previewPayload(quotePayload("14.30", "2500.00")))
          );
        }
        // Calls 2 and 3 are both held open, so the assertion below runs at a
        // moment that is pinned rather than raced: call 2 has resolved and
        // call 3 has not answered yet.
        return new Promise((resolve) => deferred.push(resolve));
      },
    });

    render(<DtfMatrixEditor persistenceEnabled />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });
    await waitFor(() => expect(screen.getByText("$2,500.00")).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));

    // Edit #1 -> preview call 2, held open.
    fireEvent.change(screen.getByLabelText("Tier 1+ T1 price"), {
      target: { value: "7.50" },
    });
    await waitFor(() => expect(previewCount).toBe(2), { timeout: 3000 });

    // Edit #2 only schedules call 3; the debounce has not elapsed.
    fireEvent.change(screen.getByLabelText("Tier 1+ T1 price"), {
      target: { value: "9.50" },
    });

    // Call 2 answers inside the debounce gap. Flushing microtasks (not timers)
    // keeps us inside it: React applies any state update this response would
    // cause, while call 3 provably has not started.
    await act(async () => {
      deferred[0](okJson(previewPayload(quotePayload("17.10", "2975.40"))));
    });

    expect(previewCount).toBe(2);
    expect(screen.queryByText("$2,975.40")).not.toBeInTheDocument();
    expect(screen.getByText("$2,500.00")).toBeVisible();

    // ...and it stays retired once the newer request is actually in flight.
    await waitFor(() => expect(previewCount).toBe(3), { timeout: 3000 });
    await act(async () => {
      deferred[1](okJson(previewPayload(quotePayload("19.10", "3323.40"))));
    });

    await waitFor(() => expect(screen.getByText("$3,323.40")).toBeVisible());
    expect(screen.queryByText("$2,975.40")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Tier 1+ T1 price")).toHaveValue(9.5);
  });

  it("keeps the last good preview when a mid-edit draft is rejected", async () => {
    let previewCount = 0;
    mockRoutedFetch({
      onPreview: () => {
        previewCount += 1;
        if (previewCount === 1) {
          return Promise.resolve(okJson(previewPayload()));
        }
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({ error: { _form: ["bad draft"] } }),
        });
      },
    });

    render(<DtfMatrixEditor persistenceEnabled />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });
    await waitFor(() => expect(previewCount).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));

    fireEvent.change(screen.getByLabelText("Tier 1+ T1 price"), {
      target: { value: "7.50" },
    });

    expect(await screen.findByText(/not previewable yet/i)).toBeVisible();
    // The cost basis survived, so DTF GM% keeps working locally.
    await waitFor(() =>
      expect(screen.getByLabelText("Tier 1+ T1 DTF GM percent")).toBeEnabled()
    );
  });
});

describe("Pricing Studio layout", () => {
  it("does not render a visible Tier column header", async () => {
    mockRoutedFetch();
    render(<DtfMatrixEditor persistenceEnabled />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });

    const table = await screen.findByTestId("dtf-matrix-table-panel");
    expect(within(table).queryByText("Tier")).not.toBeInTheDocument();
    expect(within(table).getByText("Quantity")).toBeVisible();
    expect(within(table).getByText("Basis")).toBeVisible();
  });

  it("shows a Quantity Inspector alongside the matrix", async () => {
    mockRoutedFetch();
    render(<DtfMatrixEditor persistenceEnabled />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });

    const inspector = await screen.findByTestId("dtf-quantity-inspector");
    expect(within(inspector).getByText("Quantity Inspector")).toBeVisible();
  });

  it("renders Quote Impact as a section outside the Quantity Inspector", async () => {
    mockRoutedFetch();
    render(<DtfMatrixEditor persistenceEnabled />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });

    const inspector = await screen.findByTestId("dtf-quantity-inspector");
    const quoteHeading = await screen.findByRole("heading", {
      name: "Quote Impact Preview",
    });
    expect(inspector).not.toContainElement(quoteHeading);
  });

  it("changes the inspector's displayed quantity when a different row is selected", async () => {
    await renderEditing();

    // Add a second row so there is something else to select.
    fireEvent.click(screen.getByRole("button", { name: "Manage Quantities" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add Tier" }));
    const inspector = screen.getByTestId("dtf-quantity-inspector");
    expect(within(inspector).getByText("1-100")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Select quantity 101+" }));

    expect(within(inspector).getByText("101+")).toBeVisible();
  });

  it("renders expandable mobile quantity cards instead of the desktop table below the lg breakpoint", async () => {
    mockRoutedFetch();
    render(<DtfMatrixEditor persistenceEnabled />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });

    await act(async () => {
      window.innerWidth = 500;
      window.dispatchEvent(new Event("resize"));
    });

    expect(await screen.findByTestId("dtf-mobile-tier-cards")).toBeInTheDocument();
    expect(screen.queryByTestId("dtf-matrix-table-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dtf-quantity-inspector")).not.toBeInTheDocument();
    const summary = screen.getByRole("button", { name: "Select quantity 1+" });
    expect(summary).toBeVisible();
    expect(within(summary).getByText("$6.50")).toBeVisible();
    expect(await within(summary).findByText("T1 · 50.0% GM")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));
    expect(screen.getAllByLabelText("Tier 1+ T1 price")).toHaveLength(1);
    expect(screen.getAllByLabelText("Tier 1+ T1 DTF GM percent")).toHaveLength(1);

    await act(async () => {
      window.innerWidth = 1280;
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByTestId("dtf-matrix-table-panel")).toBeInTheDocument();
    expect(screen.getByTestId("dtf-quantity-inspector")).toBeInTheDocument();
    expect(screen.queryByTestId("dtf-mobile-tier-cards")).not.toBeInTheDocument();
    // The desktop inspector is the sole editor; the table and retired mobile
    // path do not duplicate its editable controls.
    expect(screen.getAllByLabelText("Tier 1+ T1 price")).toHaveLength(1);
    expect(screen.getAllByLabelText("Tier 1+ T1 DTF GM percent")).toHaveLength(1);
  });

  it("edits complete quantity configuration from the expanded mobile card", async () => {
    window.innerWidth = 500;
    const tieredConfig = {
      ...dtfConfig,
      tiers: [
        { tier: "1-100", minQty: 1, maxQty: 100, prices: { T1: 7, T2: 6.5 } },
        { tier: "101+", minQty: 101, maxQty: null, prices: { T1: 6.5, T2: 6 } },
      ],
    };
    mockRoutedFetch({ config: tieredConfig });
    render(<DtfMatrixEditor persistenceEnabled />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });

    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));
    fireEvent.click(screen.getByRole("button", { name: "Select quantity 1-100" }));

    expect(screen.getByRole("heading", { name: "Quantity Configuration" })).toBeVisible();
    const label = screen.getByLabelText("Tier 1 label");
    const min = screen.getByLabelText("Tier 1-100 min qty");
    const max = screen.getByLabelText("Tier 1-100 max qty");
    expect(label).toBeVisible();
    expect(min).toBeVisible();
    expect(max).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete tier 1-100" })).toBeVisible();

    fireEvent.change(label, { target: { value: "Starter Tier" } });
    fireEvent.change(screen.getByLabelText("Tier Starter Tier min qty"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Tier Starter Tier max qty"), {
      target: { value: "120" },
    });
    expect(label).toHaveValue("Starter Tier");
    expect(screen.getByLabelText("Tier Starter Tier max qty")).toHaveValue(120);

    fireEvent.click(screen.getByRole("button", { name: "Select quantity 101+" }));
    expect(screen.getByRole("button", { name: "Set upper bound" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Tier 101+ min qty"), {
      target: { value: "121" },
    });

    fireEvent.click(screen.getByRole("button", { name: "+ Add Tier" }));
    fireEvent.click(screen.getByRole("button", { name: "Select quantity 221+" }));
    fireEvent.click(screen.getByRole("button", { name: "Set upper bound" }));
    expect(screen.getByLabelText("Tier 221+ max qty")).toHaveValue(320);
    fireEvent.click(screen.getByRole("button", { name: "Make open-ended" }));
    expect(screen.queryByLabelText("Tier 221+ max qty")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete tier 221+" }));
    expect(
      screen.queryByRole("button", { name: "Select quantity 221+" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set upper bound" })).toBeVisible();
  });

  it("initially selects the tier containing the default quote quantity without overriding a later selection", async () => {
    const tieredConfig = {
      ...dtfConfig,
      tiers: [
        { tier: "1-143", minQty: 1, maxQty: 143, prices: { T1: 7, T2: 6.5 } },
        { tier: "144-249", minQty: 144, maxQty: 249, prices: { T1: 6.5, T2: 6 } },
        { tier: "250+", minQty: 250, maxQty: null, prices: { T1: 6, T2: 5.5 } },
      ],
    };
    mockRoutedFetch({ config: tieredConfig });
    render(<DtfMatrixEditor persistenceEnabled />);

    const inspector = await screen.findByTestId("dtf-quantity-inspector");
    expect(await within(inspector).findByText("144-249")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Select quantity 250+" }));
    expect(within(inspector).getByText("250+")).toBeVisible();

    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "10" } });
    expect(within(inspector).getByText("250+")).toBeVisible();
  });
});

describe("calculation context", () => {
  it("keeps the pricing context on the page without a second grid", async () => {
    mockRoutedFetch();
    render(<DtfMatrixEditor persistenceEnabled />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });

    // The context is a collapsible strip so it never pushes the grid down,
    // but it lives in this component — the page has no second DTF preview to
    // go and read it from.
    const summary = (await screen.findByText("Calculation Context")).closest(
      "summary"
    ) as HTMLElement;
    expect(summary).toBeVisible();

    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details).not.toHaveAttribute("open");
    // Collapsed content is rendered but not exposed, which is the whole point
    // of <details> — assert that rather than asserting it is on screen.
    expect(screen.getByText("Product Multiplier")).not.toBeVisible();

    fireEvent.click(summary);

    expect(details).toHaveAttribute("open");
    expect(screen.getByText("Product Multiplier")).toBeVisible();
    expect(screen.getByText("2x")).toBeVisible();
    expect(screen.getByText("Commission Reserve")).toBeVisible();
    expect(screen.getByText("Project Labor / Order")).toBeVisible();

    // Exactly one DTF matrix table in this component.
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });
});
