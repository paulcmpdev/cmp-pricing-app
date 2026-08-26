import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) =>
    React.createElement("img", { src: props.src, alt: props.alt }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

vi.mock("@/lib/client/auth/UserMenu", () => ({
  default: () => null,
}));

import AdminHeader from "../AdminHeader";

describe("AdminHeader", () => {
  it("renders active section title in h1", () => {
    const html = renderToStaticMarkup(
      <AdminHeader activeSection="catalog" pricingPreviewEnabled={false} />
    );
    expect(html).toContain("CATALOG OPERATIONS");
    expect(html).toContain("Quote Desk");
  });

  it("shows Pricing Preview nav link when on catalog and preview enabled", () => {
    const html = renderToStaticMarkup(
      <AdminHeader activeSection="catalog" pricingPreviewEnabled={true} />
    );
    expect(html).toContain("CATALOG OPERATIONS");
    expect(html).toContain("Pricing Preview");
    expect(html).toContain('href="/admin/pricing"');
  });

  it("shows PRICING PREVIEW as h1 when on pricing page", () => {
    const html = renderToStaticMarkup(
      <AdminHeader activeSection="pricing" pricingPreviewEnabled={true} />
    );
    expect(html).toContain("PRICING PREVIEW");
    expect(html).toContain("Catalog Operations");
    expect(html).toContain('href="/admin"');
  });

  it("hides Pricing Preview link when preview disabled", () => {
    const html = renderToStaticMarkup(
      <AdminHeader activeSection="catalog" pricingPreviewEnabled={false} />
    );
    expect(html).not.toContain("Pricing Preview");
    expect(html).not.toContain("/admin/pricing");
  });

  it("renders Private preview read-only badge", () => {
    const html = renderToStaticMarkup(
      <AdminHeader activeSection="catalog" pricingPreviewEnabled={false} />
    );
    expect(html).toContain("Private preview");
    expect(html).toContain("Read-only");
  });

  it("renders admin section navigation with aria-label", () => {
    const html = renderToStaticMarkup(
      <AdminHeader activeSection="catalog" pricingPreviewEnabled={true} />
    );
    expect(html).toContain('aria-label="Admin sections"');
  });
});

describe("Pricing preview gate integration", () => {
  type Env = Record<string, string | undefined>;

  it("isPricingPreviewEnabled returns false in production", async () => {
    const { isPricingPreviewEnabled } = await import(
      "@/lib/server/pricing-preview-gate"
    );
    expect(
      isPricingPreviewEnabled({
        CMP_ENABLE_PRICING_PREVIEW: "true",
        VERCEL_ENV: "production",
      } as Env as typeof process.env)
    ).toBe(false);
  });

  it("isPricingPreviewEnabled returns true in development with flag", async () => {
    const { isPricingPreviewEnabled } = await import(
      "@/lib/server/pricing-preview-gate"
    );
    expect(
      isPricingPreviewEnabled({
        CMP_ENABLE_PRICING_PREVIEW: "true",
        NODE_ENV: "development",
      } as Env as typeof process.env)
    ).toBe(true);
  });

  it("isPricingPreviewEnabled returns false without flag", async () => {
    const { isPricingPreviewEnabled } = await import(
      "@/lib/server/pricing-preview-gate"
    );
    expect(
      isPricingPreviewEnabled({
        NODE_ENV: "development",
      } as Env as typeof process.env)
    ).toBe(false);
  });

  it("isPricingPreviewEnabled returns true for Vercel preview", async () => {
    const { isPricingPreviewEnabled } = await import(
      "@/lib/server/pricing-preview-gate"
    );
    expect(
      isPricingPreviewEnabled({
        CMP_ENABLE_PRICING_PREVIEW: "true",
        VERCEL_ENV: "preview",
      } as Env as typeof process.env)
    ).toBe(true);
  });

  it("isPricingPreviewEnabled returns true for test env", async () => {
    const { isPricingPreviewEnabled } = await import(
      "@/lib/server/pricing-preview-gate"
    );
    expect(
      isPricingPreviewEnabled({
        CMP_ENABLE_PRICING_PREVIEW: "true",
        NODE_ENV: "test",
      } as Env as typeof process.env)
    ).toBe(true);
  });
});
