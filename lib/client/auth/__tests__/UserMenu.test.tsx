// @vitest-environment jsdom

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: {
      user: {
        email: "paul@cmpsportswear.com",
        role: "admin",
      },
    },
  }),
  signOut: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

import UserMenu from "../UserMenu";

describe("UserMenu", () => {
  it("keeps role and sign-out accessible while hiding email in compact mobile mode", () => {
    render(<UserMenu compactOnMobile />);

    expect(screen.getByTestId("user-email")).toHaveClass("hidden", "lg:inline");
    expect(screen.getByTestId("user-role")).toHaveTextContent("Admin");
    expect(screen.getByTestId("sign-out-btn")).toHaveClass("min-h-[44px]");
  });
});