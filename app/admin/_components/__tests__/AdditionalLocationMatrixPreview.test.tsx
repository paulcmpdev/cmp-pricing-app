// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import AdditionalLocationMatrixPreview from "../AdditionalLocationMatrixPreview";

const DEBOUNCE_MS = 400;

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

function makePreview(t1Draft = 2.4, isDirty = false) {
  return {
    marginLanes: { T1: 0.58, T2: 0.52, T3: 0.44, T4: 0.35 },
    draftMargins: { T1: isDirty ? 0.6 : 0.58, T2: 0.52, T3: 0.44, T4: 0.35 },
    isDirty,
    rows: [
      {
        printKey: "left-sleeve",
        location: "Left Sleeve",
        widthIn: 4,
        heightIn: 4,
        tier: "72-143",
        minQty: 72,
        maxQty: 143,
        cogsPerPiece: 1,
        prices: {
          T1: { current: 2.4, draft: t1Draft, delta: t1Draft - 2.4 },
          T2: { current: 2.1, draft: 2.1, delta: 0 },
          T3: { current: 1.8, draft: 1.8, delta: 0 },
          T4: { current: 1.55, draft: 1.55, delta: 0 },
        },
      },
    ],
  };
}

function okJson(data: unknown) {
  return { ok: true, status: 200, json: async () => data };
}

function requestBodyAt(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  return JSON.parse(fetchMock.mock.calls[index][1].body as string);
}

async function renderLoaded(fetchMock: ReturnType<typeof vi.fn>) {
  fetchMock.mockResolvedValueOnce(okJson(makePreview()));
  render(<AdditionalLocationMatrixPreview />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.getByText("Left Sleeve")).toBeInTheDocument();
}

describe("AdditionalLocationMatrixPreview", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends exactly one initial baseline preview request", async () => {
    await renderLoaded(fetchMock);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBodyAt(fetchMock, 0)).toEqual({ edits: {} });
  });

  it("one valid margin edit sends one recalculation request without response-driven repeats", async () => {
    await renderLoaded(fetchMock);
    fetchMock.mockResolvedValue(okJson(makePreview(2.45, true)));

    fireEvent.change(screen.getByLabelText("T1 component margin percent"), {
      target: { value: "58.5" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodyAt(fetchMock, 1)).toEqual({ edits: { T1: 58.5 } });
    expect(screen.getByText(/1 change/i)).toBeInTheDocument();
  });

  it("reset all from dirty sends exactly one baseline preview request", async () => {
    await renderLoaded(fetchMock);
    fetchMock.mockResolvedValueOnce(okJson(makePreview(2.55, true)));

    fireEvent.change(screen.getByLabelText("T1 component margin percent"), {
      target: { value: "60" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValue(okJson(makePreview()));
    fireEvent.click(screen.getByRole("button", { name: /reset all margin edits/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestBodyAt(fetchMock, 2)).toEqual({ edits: {} });
    expect(screen.queryByText(/change/i)).not.toBeInTheDocument();
  });

  it("reset lane that returns the final dirty lane to baseline sends one baseline preview request", async () => {
    await renderLoaded(fetchMock);
    fetchMock.mockResolvedValueOnce(okJson(makePreview(2.55, true)));

    fireEvent.change(screen.getByLabelText("T1 component margin percent"), {
      target: { value: "60" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValue(okJson(makePreview()));
    fireEvent.click(screen.getByRole("button", { name: /reset T1 margin/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestBodyAt(fetchMock, 2)).toEqual({ edits: {} });
    expect(screen.queryByText(/change/i)).not.toBeInTheDocument();
  });

  it("numeric-equivalent 58.0 is unchanged: no dirty state, unload warning, or recalculation", async () => {
    await renderLoaded(fetchMock);

    fireEvent.change(screen.getByLabelText("T1 component margin percent"), {
      target: { value: "58.0" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    });

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/change/i)).not.toBeInTheDocument();
    expect(event.defaultPrevented).toBe(false);
  });

  it("valid 58.5 is one dirty change and one recalculation request", async () => {
    await renderLoaded(fetchMock);
    fetchMock.mockResolvedValue(okJson(makePreview(2.45, true)));

    fireEvent.change(screen.getByLabelText("T1 component margin percent"), {
      target: { value: "58.5" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodyAt(fetchMock, 1)).toEqual({ edits: { T1: 58.5 } });
    expect(screen.getByTestId("al-change-count")).toHaveTextContent("1 change");
  });

  it("rejects fractional percent input like 0.58, pauses preview, and sends no invalid request", async () => {
    await renderLoaded(fetchMock);
    const callsBeforeInvalid = fetchMock.mock.calls.length;

    fireEvent.change(screen.getByLabelText("T1 component margin percent"), {
      target: { value: "0.58" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });

    expect(screen.getByText(/enter percentage points/i)).toBeInTheDocument();
    expect(screen.getByTestId("al-preview-paused")).toHaveTextContent(/preview paused/i);
    expect(screen.getByText(/1 change/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeInvalid);
  });

  it("rejects 336 and blank values without requesting a preview", async () => {
    await renderLoaded(fetchMock);
    const input = screen.getByLabelText("T1 component margin percent");
    const callsBeforeInvalid = fetchMock.mock.calls.length;

    fireEvent.change(input, { target: { value: "336" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });

    expect(screen.getByText(/max 99/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeInvalid);

    fireEvent.change(input, { target: { value: "" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });

    expect(screen.getByText(/required/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeInvalid);
  });

  it("reset clears invalid errors and recalculates baseline", async () => {
    await renderLoaded(fetchMock);

    fireEvent.change(screen.getByLabelText("T1 component margin percent"), {
      target: { value: "0.58" },
    });
    expect(screen.getByTestId("al-preview-paused")).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(okJson(makePreview()));
    fireEvent.click(screen.getByRole("button", { name: /reset all margin edits/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(screen.queryByTestId("al-preview-paused")).not.toBeInTheDocument();
    expect(screen.queryByText(/enter percentage points/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("T1 component margin percent")).toHaveValue(58);
  });

  it("valid recovery accepts 58.5 percentage points and recalculates", async () => {
    await renderLoaded(fetchMock);
    const input = screen.getByLabelText("T1 component margin percent");

    fireEvent.change(input, { target: { value: "0.58" } });
    expect(screen.getByTestId("al-preview-paused")).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(okJson(makePreview(2.45, true)));
    fireEvent.change(input, { target: { value: "58.5" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });

    expect(screen.queryByTestId("al-preview-paused")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/admin/pricing/additional-locations/preview",
      expect.objectContaining({
        body: JSON.stringify({ edits: { T1: 58.5 } }),
      })
    );
  });

  it("changed cells show Current, Draft, and Delta labels together", async () => {
    await renderLoaded(fetchMock);
    fetchMock.mockResolvedValueOnce(okJson(makePreview(2.55, true)));

    fireEvent.change(screen.getByLabelText("T1 component margin percent"), {
      target: { value: "60" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });

    const changedCell = screen.getByTestId("al-price-left-sleeve-72-143-T1");
    expect(within(changedCell).getByText("Current")).toBeInTheDocument();
    expect(within(changedCell).getAllByText("Draft").length).toBeGreaterThanOrEqual(1);
    expect(within(changedCell).getByText("Delta")).toBeInTheDocument();
  });

  it("only latest valid preview response can set table state", async () => {
    await renderLoaded(fetchMock);
    const input = screen.getByLabelText("T1 component margin percent");
    const slow = deferred<unknown>();
    const fast = deferred<unknown>();
    fetchMock.mockReturnValueOnce(slow.promise);
    fetchMock.mockReturnValueOnce(fast.promise);

    fireEvent.change(input, { target: { value: "60" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });

    fireEvent.change(input, { target: { value: "61" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    });

    await act(async () => {
      fast.resolve(okJson(makePreview(2.65, true)));
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      slow.resolve(okJson(makePreview(9.99, true)));
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(screen.getAllByText("$2.65").length).toBeGreaterThan(0);
    expect(screen.queryByText("$9.99")).not.toBeInTheDocument();
  });

  it("invalid edited input participates in beforeunload dirty tracking", async () => {
    await renderLoaded(fetchMock);

    fireEvent.change(screen.getByLabelText("T1 component margin percent"), {
      target: { value: "0.58" },
    });

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});
