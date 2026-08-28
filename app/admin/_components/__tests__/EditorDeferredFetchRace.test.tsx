// @vitest-environment jsdom
//
// Regression coverage for the fetchConfig completion-time guard in both
// matrix editors. The real app already prevents a draft from going dirty
// during a rollback reload via VersionHistoryPanel's onRollbackStateChange
// lock (see PricingMatrixEditors.test.tsx). These tests bypass that lock by
// stubbing VersionHistoryPanel with a bare button that invokes onRolledBack
// directly, so a GET started while the draft was clean can still race a
// draft edit that lands before the response resolves — isolating the
// defense-in-depth guard inside fetchConfig itself from the surrounding
// lock that normally makes the race unreachable.

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("../VersionHistoryPanel", () => ({
  default: ({ onRolledBack }: { onRolledBack: () => void | Promise<void> }) => (
    <button onClick={() => { onRolledBack(); }}>Simulate Reload</button>
  ),
}));

import DtfMatrixEditor from "../DtfMatrixEditor";
import AdditionalPrintsEditor from "../AdditionalPrintsEditor";

const activeVersion = {
  id: "22222222-2222-2222-2222-222222222222",
  createdBy: "admin@cmpsportswear.com",
  createdAt: "2026-02-01T00:00:00.000Z",
  activatedAt: "2026-02-01T00:00:00.000Z",
};

const dtfConfig = {
  lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
  tiers: [{ tier: "1+", minQty: 1, maxQty: null, prices: { T1: 5 } }],
};

const additionalPrintsConfig = {
  services: [
    {
      key: "sleeve_print",
      name: "Sleeve Print",
      description: "One standard sleeve print",
      type: "service",
      geometryKey: "FLAT_SLEEVE",
      composition: [{ sizeKey: "FLAT_SLEEVE", quantityPerShirt: 1 }],
      cogs: 2.1,
      operatorOperatingCost: 0.19,
      enginePrice: 6,
      policyFloor: 5,
      manualOverride: null,
      effectivePrice: 6,
      grossMargin: 0.65,
      status: "Engine price",
      operatorMinPerShirt: 2,
      designerMinPerOrder: 5,
      active: true,
      sortOrder: 0,
    },
  ],
  columns: [
    { key: "name", label: "Service", required: true, visible: true, order: 0 },
    { key: "effectivePrice", label: "Price", required: true, visible: true, order: 1 },
    { key: "description", label: "Description", required: false, visible: true, order: 2 },
  ],
  minimumBillableQuantity: 12,
};

function okJson(data: unknown) {
  return { ok: true, status: 200, json: async () => data };
}

describe("fetchConfig deferred-GET race guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("DTF editor: keeps a draft that goes dirty while a reload GET is in flight", async () => {
    let callCount = 0;
    let resolveReload: (value: unknown) => void = () => {};
    globalThis.fetch = vi.fn(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(
          okJson({ data: dtfConfig, version: activeVersion, source: "database" })
        );
      }
      return new Promise((resolve) => {
        resolveReload = resolve;
      });
    }) as unknown as typeof fetch;

    render(<DtfMatrixEditor persistenceEnabled={true} />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });

    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));
    const priceInput = screen.getByLabelText("Tier 1+ T1 price") as HTMLInputElement;
    expect(priceInput).toHaveValue(5);

    // Start a reload while the draft is clean — the pre-check passes and the
    // GET is dispatched.
    fireEvent.click(screen.getByRole("button", { name: "Simulate Reload" }));
    await waitFor(() => expect(callCount).toBe(2));

    // A draft edit lands after the request started but before it resolves.
    fireEvent.change(priceInput, { target: { value: "42" } });
    expect(priceInput).toHaveValue(42);

    // The in-flight GET now resolves with fresh (unedited) server data.
    resolveReload(okJson({ data: dtfConfig, version: activeVersion, source: "database" }));

    await waitFor(() =>
      expect(
        screen.getByText(/your in-progress draft changes were kept/i)
      ).toBeInTheDocument()
    );

    // The draft survives — the completion-time guard refused to clobber it.
    expect(priceInput).toHaveValue(42);
    expect(screen.getByRole("button", { name: "Save Changes" })).not.toBeDisabled();
  });

  it("Additional Prints editor: keeps a draft that goes dirty while a reload GET is in flight", async () => {
    let callCount = 0;
    let resolveReload: (value: unknown) => void = () => {};
    globalThis.fetch = vi.fn(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(
          okJson({ data: additionalPrintsConfig, version: activeVersion, source: "database" })
        );
      }
      return new Promise((resolve) => {
        resolveReload = resolve;
      });
    }) as unknown as typeof fetch;

    render(<AdditionalPrintsEditor persistenceEnabled={true} />);
    await screen.findByRole("heading", { name: "Additional Prints / DTF Flat Fees" });

    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));
    const priceInput = screen.getByLabelText("Approved price for sleeve_print") as HTMLInputElement;
    expect(priceInput).toHaveValue(6);

    fireEvent.click(screen.getByRole("button", { name: "Simulate Reload" }));
    await waitFor(() => expect(callCount).toBe(2));

    fireEvent.change(priceInput, { target: { value: "99" } });
    expect(priceInput).toHaveValue(99);

    resolveReload(
      okJson({ data: additionalPrintsConfig, version: activeVersion, source: "database" })
    );

    await waitFor(() =>
      expect(
        screen.getByText(/your in-progress draft changes were kept/i)
      ).toBeInTheDocument()
    );

    expect(priceInput).toHaveValue(99);
    expect(screen.getByRole("button", { name: "Save Changes" })).not.toBeDisabled();
  });
});
