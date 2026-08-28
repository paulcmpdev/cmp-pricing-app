// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import DtfMatrixEditor from "../DtfMatrixEditor";
import AdditionalPrintsEditor from "../AdditionalPrintsEditor";

const dtfConfig = {
  lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
  tiers: [
    { tier: "1+", minQty: 1, maxQty: null, prices: { T1: 5 } },
  ],
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
      cogs: 2.1023624876725835,
      operatorOperatingCost: 0.19397707100591716,
      enginePrice: 6,
      policyFloor: 5,
      manualOverride: null,
      effectivePrice: 6,
      grossMargin: 0.6496062520545695,
      status: "Engine price",
      operatorMinPerShirt: 2,
      designerMinPerOrder: 5,
      active: true,
      sortOrder: 0,
    },
    {
      key: "vertical_print",
      name: "Vertical Print",
      description: "One vertical print location",
      type: "service",
      geometryKey: "FLAT_VERTICAL",
      composition: [{ sizeKey: "FLAT_VERTICAL", quantityPerShirt: 1 }],
      cogs: 2.6973745069033526,
      operatorOperatingCost: 0.19397707100591716,
      enginePrice: 7,
      policyFloor: 0,
      manualOverride: null,
      effectivePrice: 7,
      grossMargin: 0.6146607847280924,
      status: "Engine price",
      operatorMinPerShirt: 0,
      designerMinPerOrder: 5,
      active: true,
      sortOrder: 1,
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

describe("pricing matrix editors", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    Object.defineProperty(window, "innerWidth", { value: 1280, writable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the DTF matrix read-only by default and splits an open-ended tier safely", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      okJson({ data: dtfConfig, version: null, source: "baseline" })
    ) as unknown as typeof fetch;

    render(<DtfMatrixEditor persistenceEnabled={false} />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });

    expect(screen.getByRole("button", { name: "Edit Matrix" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));
    expect(screen.getByText("Preview Only")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Manage Quantities" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add Tier" }));

    expect(screen.getByDisplayValue("101+")).toBeVisible();
    expect(screen.getByLabelText("Tier 1+ max qty")).toHaveValue(100);
    expect(screen.queryByText(/only the final tier may be open-ended/i)).not.toBeInTheDocument();
  });

  it("cancels DTF edits without retaining the new tier", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      okJson({ data: dtfConfig, version: null, source: "baseline" })
    ) as unknown as typeof fetch;

    render(<DtfMatrixEditor persistenceEnabled={false} />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });
    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage Quantities" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add Tier" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByDisplayValue("101+")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Matrix" })).toBeVisible();
  });

  it("adds an Additional Prints row via Manage Services and controls optional columns only in edit mode", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      okJson({ data: additionalPrintsConfig, version: null, source: "baseline" })
    ) as unknown as typeof fetch;

    render(<AdditionalPrintsEditor persistenceEnabled={false} />);
    await screen.findByRole("heading", { name: "Additional Prints / DTF Flat Fees" });

    expect(screen.getByText("Sleeve Print")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Manage Services" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));
    expect(screen.getByText("Preview Only")).toBeVisible();

    const manageServicesTrigger = screen.getByRole("button", { name: "Manage Services" });
    fireEvent.click(manageServicesTrigger);
    const manageServicesDialog = screen.getByRole("dialog", { name: "Manage Services" });
    expect(manageServicesDialog).toBeVisible();
    expect(screen.getByRole("button", { name: "Close Manage Services" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "+ Add Service" }));
    expect(screen.getByDisplayValue("New Service")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Close Manage Services" }));
    expect(manageServicesTrigger).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    const descriptionToggle = screen.getByRole("checkbox", {
      name: "Toggle Description column",
    });
    expect(descriptionToggle).toBeChecked();
    fireEvent.click(descriptionToggle);
    await waitFor(() => expect(descriptionToggle).not.toBeChecked());
  });

  it("uses one Additional Prints price edit path on mobile and keeps the card summary/details", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      okJson({ data: additionalPrintsConfig, version: null, source: "baseline" })
    ) as unknown as typeof fetch;

    render(<AdditionalPrintsEditor persistenceEnabled={false} />);
    await screen.findByRole("heading", { name: "Additional Prints / DTF Flat Fees" });
    await act(async () => {
      window.innerWidth = 800;
      window.dispatchEvent(new Event("resize"));
    });

    const cards = screen.getByTestId("ap-mobile-card-list");
    expect(screen.queryByTestId("ap-desktop-table-panel")).not.toBeInTheDocument();
    expect(within(cards).getByText("$6.00")).toBeVisible();
    expect(within(cards).getByText("65.0% GM")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Expand Sleeve Print" }));
    expect(within(cards).getByText("Description")).toBeVisible();
    expect(within(cards).getByText("One standard sleeve print")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));
    expect(screen.getAllByLabelText("Decoration Price for sleeve_print")).toHaveLength(1);
    expect(screen.queryByTestId("ap-desktop-table-panel")).not.toBeInTheDocument();

    // Advanced fields (description, etc.) are edited via Manage Services,
    // not inline on the card — exactly one editable Price/GM path per view.
    fireEvent.click(screen.getByRole("button", { name: "Manage Services" }));
    expect(screen.getByLabelText("Description for sleeve_print")).toBeVisible();
  });

  it("shows version history and rolls back to a superseded version", async () => {
    const activeVersion = {
      id: "22222222-2222-2222-2222-222222222222",
      createdBy: "admin@cmpsportswear.com",
      createdAt: "2026-02-01T00:00:00.000Z",
      activatedAt: "2026-02-01T00:00:00.000Z",
    };
    const activateSpy = vi.fn().mockResolvedValue(okJson({ ok: true, version: activeVersion }));
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes("/api/admin/pricing/config/history")) {
        return Promise.resolve(
          okJson({
            versions: [
              { ...activeVersion, status: "active", supersededAt: null },
              {
                id: "11111111-1111-1111-1111-111111111111",
                status: "superseded",
                createdBy: "admin@cmpsportswear.com",
                createdAt: "2026-01-01T00:00:00.000Z",
                activatedAt: "2026-01-01T00:00:00.000Z",
                supersededAt: "2026-02-01T00:00:00.000Z",
              },
            ],
          })
        );
      }
      if (url.includes("/api/admin/pricing/config/activate")) {
        return activateSpy();
      }
      return Promise.resolve(okJson({ data: dtfConfig, version: activeVersion, source: "database" }));
    }) as unknown as typeof fetch;

    render(<DtfMatrixEditor persistenceEnabled={true} />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });

    fireEvent.click(screen.getByRole("button", { name: "Version History" }));
    await screen.findByText("superseded");

    fireEvent.click(
      screen.getByRole("button", { name: /^Roll back to version 11111111/ })
    );

    await waitFor(() => expect(activateSpy).toHaveBeenCalled());
  });

  it("disables rollback while a DTF draft is dirty so unsaved edits can't be silently discarded", async () => {
    const activeVersion = {
      id: "22222222-2222-2222-2222-222222222222",
      createdBy: "admin@cmpsportswear.com",
      createdAt: "2026-02-01T00:00:00.000Z",
      activatedAt: "2026-02-01T00:00:00.000Z",
    };
    const activateSpy = vi.fn().mockResolvedValue(okJson({ ok: true, version: activeVersion }));
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes("/api/admin/pricing/config/history")) {
        return Promise.resolve(
          okJson({
            versions: [
              { ...activeVersion, status: "active", supersededAt: null },
              {
                id: "11111111-1111-1111-1111-111111111111",
                status: "superseded",
                createdBy: "admin@cmpsportswear.com",
                createdAt: "2026-01-01T00:00:00.000Z",
                activatedAt: "2026-01-01T00:00:00.000Z",
                supersededAt: "2026-02-01T00:00:00.000Z",
              },
            ],
          })
        );
      }
      if (url.includes("/api/admin/pricing/config/activate")) {
        return activateSpy();
      }
      return Promise.resolve(okJson({ data: dtfConfig, version: activeVersion, source: "database" }));
    }) as unknown as typeof fetch;

    render(<DtfMatrixEditor persistenceEnabled={true} />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });

    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage Quantities" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add Tier" }));

    fireEvent.click(screen.getByRole("button", { name: "Version History" }));
    await screen.findByText("superseded");

    expect(screen.getByTestId("version-history-dirty-warning")).toHaveTextContent(
      /unsaved draft changes/i
    );
    const rollbackButton = screen.getByRole("button", {
      name: /^Roll back to version 11111111/,
    });
    expect(rollbackButton).toBeDisabled();

    fireEvent.click(rollbackButton);
    expect(activateSpy).not.toHaveBeenCalled();

    // The unsaved tier is still there — nothing was silently discarded.
    expect(screen.getByDisplayValue("101+")).toBeVisible();
  });

  function mockDeferredRollbackFetch(activeVersion: {
    id: string;
    createdBy: string;
    createdAt: string;
    activatedAt: string;
  }) {
    const historyPayload = okJson({
      versions: [
        { ...activeVersion, status: "active", supersededAt: null },
        {
          id: "11111111-1111-1111-1111-111111111111",
          status: "superseded",
          createdBy: "admin@cmpsportswear.com",
          createdAt: "2026-01-01T00:00:00.000Z",
          activatedAt: "2026-01-01T00:00:00.000Z",
          supersededAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    });
    let resolveActivate: (value: unknown) => void = () => {};
    const activatePromise = new Promise((resolve) => {
      resolveActivate = resolve;
    });
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes("/api/admin/pricing/config/history")) {
        return Promise.resolve(historyPayload);
      }
      if (url.includes("/api/admin/pricing/config/activate")) {
        return activatePromise;
      }
      // GET config (initial load + post-rollback reload)
      return Promise.resolve(okJson({ data: dtfConfig, version: activeVersion, source: "database" }));
    }) as unknown as typeof fetch;
    return { resolveActivate };
  }

  it("blocks entering edit mode for the entire deferred rollback lifecycle", async () => {
    const activeVersion = {
      id: "22222222-2222-2222-2222-222222222222",
      createdBy: "admin@cmpsportswear.com",
      createdAt: "2026-02-01T00:00:00.000Z",
      activatedAt: "2026-02-01T00:00:00.000Z",
    };
    const { resolveActivate } = mockDeferredRollbackFetch(activeVersion);

    render(<DtfMatrixEditor persistenceEnabled={true} />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });

    // Start a rollback while clean and not editing — the pre-click dirty
    // guard allows this.
    fireEvent.click(screen.getByRole("button", { name: "Version History" }));
    await screen.findByText("superseded");
    fireEvent.click(
      screen.getByRole("button", { name: /^Roll back to version 11111111/ })
    );

    // Activation promise is now pending — Edit Matrix must be locked out.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit Matrix" })).toBeDisabled()
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();

    // Resolve the activation request — completes the rollback lifecycle.
    resolveActivate(okJson({ ok: true, version: activeVersion }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit Matrix" })).not.toBeDisabled()
    );

    // No stray draft leaked through: entering edit mode now reflects the
    // freshly reloaded (rolled-back) config with nothing unsaved.
    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));
    expect(screen.getByLabelText("Tier 1+ T1 price")).toHaveValue(5);
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });

  it("blocks draft mutation of an already-open clean draft for the entire deferred rollback lifecycle", async () => {
    const activeVersion = {
      id: "22222222-2222-2222-2222-222222222222",
      createdBy: "admin@cmpsportswear.com",
      createdAt: "2026-02-01T00:00:00.000Z",
      activatedAt: "2026-02-01T00:00:00.000Z",
    };
    const { resolveActivate } = mockDeferredRollbackFetch(activeVersion);

    render(<DtfMatrixEditor persistenceEnabled={true} />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });

    // Enter edit mode while clean — legitimate, since nothing is dirty yet.
    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));
    const priceInput = screen.getByLabelText("Tier 1+ T1 price") as HTMLInputElement;
    expect(priceInput).toHaveValue(5);
    fireEvent.click(screen.getByRole("button", { name: "Manage Quantities" }));

    // Start a rollback (clean draft — the pre-click dirty guard allows this
    // even though editing is already open).
    fireEvent.click(screen.getByRole("button", { name: "Version History" }));
    await screen.findByText("superseded");
    fireEvent.click(
      screen.getByRole("button", { name: /^Roll back to version 11111111/ })
    );

    // Activation promise is now pending — the open draft must be frozen.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled()
    );

    fireEvent.change(priceInput, { target: { value: "999" } });
    expect(priceInput).toHaveValue(5); // unchanged — mutation was blocked

    fireEvent.click(screen.getByRole("button", { name: "+ Add Tier" }));
    expect(screen.queryByDisplayValue(/101\+/)).not.toBeInTheDocument();

    // Resolve the activation request — completes the rollback lifecycle.
    resolveActivate(okJson({ ok: true, version: activeVersion }));

    await waitFor(() => expect(screen.getByLabelText("Tier 1+ T1 price")).toHaveValue(5));
    // Still no draft: the reloaded (rolled-back) data replaced the draft
    // cleanly and Save remains disabled since nothing is dirty.
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });

  it("hides Version History behind a Preview Only explanation when persistence is disabled, and never calls the history API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ data: dtfConfig, version: null, source: "baseline" })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<DtfMatrixEditor persistenceEnabled={false} />);
    await screen.findByRole("heading", { name: "DTF Pricing Matrix" });

    expect(screen.queryByRole("button", { name: "Version History" })).not.toBeInTheDocument();
    expect(screen.getByTestId("version-history-preview-only")).toHaveTextContent(
      /preview only mode/i
    );
    expect(screen.queryByText("Not found.")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/config/history"))
    ).toBe(false);
  });

  it("moves an Additional Prints row and keeps sortOrder unique/contiguous after delete + add", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      okJson({ data: additionalPrintsConfig, version: null, source: "baseline" })
    ) as unknown as typeof fetch;

    render(<AdditionalPrintsEditor persistenceEnabled={false} />);
    await screen.findByRole("heading", { name: "Additional Prints / DTF Flat Fees" });
    fireEvent.click(screen.getByRole("button", { name: "Edit Matrix" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage Services" }));

    const rowOrder = () =>
      screen.getAllByLabelText(/^Name for /).map((el) => (el as HTMLInputElement).value);

    expect(rowOrder()).toEqual(["Sleeve Print", "Vertical Print"]);

    fireEvent.click(screen.getByRole("button", { name: "Move Sleeve Print down" }));
    expect(rowOrder()).toEqual(["Vertical Print", "Sleeve Print"]);

    // Delete the first row, then add a new one. If sortOrder weren't
    // renormalized on delete, the new row could collide with a stale value.
    fireEvent.click(screen.getByRole("button", { name: "Delete Vertical Print" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add Service" }));
    expect(rowOrder()).toEqual(["Sleeve Print", "New Service"]);
  });
});
