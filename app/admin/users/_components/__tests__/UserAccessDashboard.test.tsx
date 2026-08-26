// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import UserAccessDashboard from "../UserAccessDashboard";

describe("UserAccessDashboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("blocks a no-op role change until a different role is selected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          users: [
            {
              email: "rep@cmpsportswear.com",
              name: "Preview Rep",
              image: null,
              role: "sales_rep",
              status: "active",
              version: 2,
              createdAt: "2026-08-26T00:00:00.000Z",
              updatedAt: "2026-08-26T00:00:00.000Z",
              lastSignInAt: null,
              isBootstrapAdmin: false,
            },
          ],
          counts: { pending: 0, active: 1, disabled: 0, admins: 0 },
        }),
      })
    );

    render(<UserAccessDashboard />);

    await screen.findAllByText("rep@cmpsportswear.com");
    fireEvent.click(screen.getAllByRole("button", { name: "Change Role" })[0]);

    const confirm = screen.getByTestId("confirm-action-btn");
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByRole("combobox", { name: "Select role" }), {
      target: { value: "manager" },
    });

    await waitFor(() => expect(confirm).toBeEnabled());
  });
});
