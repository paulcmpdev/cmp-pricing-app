// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import VersionHistoryPanel from "../VersionHistoryPanel";

function okJson(data: unknown) {
  return { ok: true, status: 200, json: async () => data };
}

const historyResponse = {
  versions: [
    {
      id: "22222222-2222-2222-2222-222222222222",
      status: "active",
      createdBy: "admin@cmpsportswear.com",
      createdAt: "2026-02-01T00:00:00.000Z",
      activatedAt: "2026-02-01T00:00:00.000Z",
      supersededAt: null,
    },
    {
      id: "11111111-1111-1111-1111-111111111111",
      status: "superseded",
      createdBy: "admin@cmpsportswear.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      activatedAt: "2026-01-01T00:00:00.000Z",
      supersededAt: "2026-02-01T00:00:00.000Z",
    },
  ],
};

describe("VersionHistoryPanel draft safety", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables rollback and warns instead of silently discarding a dirty draft", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson(historyResponse));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      <VersionHistoryPanel
        configType="dtf_matrix"
        currentVersionId="22222222-2222-2222-2222-222222222222"
        persistenceEnabled={true}
        onRolledBack={vi.fn()}
        isDraftDirty={true}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Version History" }));
    await screen.findByText("superseded");

    expect(screen.getByTestId("version-history-dirty-warning")).toHaveTextContent(
      /unsaved draft changes/i
    );

    const rollbackButton = screen.getByRole("button", {
      name: /^Roll back to version 11111111/,
    });
    expect(rollbackButton).toBeDisabled();

    // Even if something forces a click through, no activation request should fire
    // and the confirm dialog (the discard-loss gate) must never even be reached.
    fireEvent.click(rollbackButton);
    expect(window.confirm).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/config/activate"))
    ).toBe(false);
  });

  it("allows rollback once the draft is clean", async () => {
    const activateSpy = vi
      .fn()
      .mockResolvedValue(okJson({ ok: true, version: historyResponse.versions[0] }));
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes("/config/history")) return Promise.resolve(okJson(historyResponse));
      if (url.includes("/config/activate")) return activateSpy();
      return Promise.resolve(okJson({}));
    }) as unknown as typeof fetch;

    const onRolledBack = vi.fn();
    render(
      <VersionHistoryPanel
        configType="dtf_matrix"
        currentVersionId="22222222-2222-2222-2222-222222222222"
        persistenceEnabled={true}
        onRolledBack={onRolledBack}
        isDraftDirty={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Version History" }));
    await screen.findByText("superseded");

    expect(screen.queryByTestId("version-history-dirty-warning")).not.toBeInTheDocument();

    const rollbackButton = screen.getByRole("button", {
      name: /^Roll back to version 11111111/,
    });
    expect(rollbackButton).not.toBeDisabled();

    fireEvent.click(rollbackButton);
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(activateSpy).toHaveBeenCalled());
    await waitFor(() => expect(onRolledBack).toHaveBeenCalled());
  });

  it("keeps the parent's rollback lock engaged until the awaited onRolledBack reload finishes", async () => {
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes("/config/history")) return Promise.resolve(okJson(historyResponse));
      if (url.includes("/config/activate")) {
        return Promise.resolve(okJson({ ok: true, version: historyResponse.versions[0] }));
      }
      return Promise.resolve(okJson({}));
    }) as unknown as typeof fetch;

    let resolveReload: () => void = () => {};
    const reloadPromise = new Promise<void>((resolve) => {
      resolveReload = resolve;
    });
    const onRolledBack = vi.fn().mockReturnValue(reloadPromise);
    const onRollbackStateChange = vi.fn();

    render(
      <VersionHistoryPanel
        configType="dtf_matrix"
        currentVersionId="22222222-2222-2222-2222-222222222222"
        persistenceEnabled={true}
        onRolledBack={onRolledBack}
        isDraftDirty={false}
        onRollbackStateChange={onRollbackStateChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Version History" }));
    await screen.findByText("superseded");

    fireEvent.click(
      screen.getByRole("button", { name: /^Roll back to version 11111111/ })
    );

    await waitFor(() => expect(onRolledBack).toHaveBeenCalled());
    // The parent's reload (onRolledBack) is in flight — the lock must still
    // be engaged; it must not be released while the reload is still pending.
    expect(onRollbackStateChange).toHaveBeenCalledWith(true);
    expect(onRollbackStateChange).not.toHaveBeenCalledWith(false);

    resolveReload();
    await waitFor(() => expect(onRollbackStateChange).toHaveBeenCalledWith(false));

    const trueCallIndex = onRollbackStateChange.mock.calls.findIndex(([v]) => v === true);
    const falseCallIndex = onRollbackStateChange.mock.calls.findIndex(([v]) => v === false);
    expect(trueCallIndex).toBeGreaterThanOrEqual(0);
    expect(falseCallIndex).toBeGreaterThan(trueCallIndex);
  });
});
