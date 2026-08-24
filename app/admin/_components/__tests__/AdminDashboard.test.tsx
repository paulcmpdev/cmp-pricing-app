import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AdminDashboard from "../AdminDashboard";
import type {
  AdminCatalogOverview,
  AdminCatalogVendorOverview,
} from "@/lib/server/vendor-catalog/admin-overview";

function vendor(
  overrides: Partial<AdminCatalogVendorOverview> = {}
): AdminCatalogVendorOverview {
  return {
    label: "S&S Activewear",
    active: true,
    health: "healthy",
    activeImportStatus: "active",
    styleCount: 6381,
    variantCount: 221824,
    sourceStatus: "completed",
    sourceErrors: 0,
    sourceSyncAt: "2026-08-23T12:00:00.000Z",
    importedAt: "2026-08-23T12:05:00.000Z",
    activatedAt: "2026-08-23T12:10:00.000Z",
    canaryStyleCode: "3001",
    canaryStyleRows: 1,
    canaryVariantRows: 24,
    ...overrides,
  };
}

function partialOverview(): AdminCatalogOverview {
  return {
    available: true,
    backend: "postgres",
    generatedAt: "2026-08-23T12:30:00.000Z",
    vendors: {
      ss: vendor(),
      sanmar: vendor({
        label: "SanMar",
        active: false,
        health: "unavailable",
        activeImportStatus: null,
        styleCount: 0,
        variantCount: 0,
        sourceStatus: null,
        sourceSyncAt: null,
        importedAt: null,
        activatedAt: null,
        canaryStyleCode: "K500",
        canaryStyleRows: 0,
        canaryVariantRows: 0,
      }),
    },
    recentJobs: [
      {
        vendor: "ss",
        status: "completed",
        phase: "completed",
        attempts: 1,
        createdAt: "2026-08-23T11:00:00.000Z",
        startedAt: "2026-08-23T11:01:00.000Z",
        completedAt: "2026-08-23T11:05:00.000Z",
      },
    ],
    rollbackSummary: {
      ss: { totalCount: 1, latestAt: "2026-08-22T12:00:00.000Z" },
      sanmar: { totalCount: 0, latestAt: null },
    },
    sectionAvailability: {
      recentJobs: true,
      rollbackSummary: true,
    },
    totals: {
      styleCount: 6381,
      variantCount: 221824,
      healthyVendorCount: 1,
    },
  };
}

describe("AdminDashboard", () => {
  it("keeps operational diagnostics visible when one vendor is unavailable", () => {
    const html = renderToStaticMarkup(
      <AdminDashboard overview={partialOverview()} />
    );

    expect(html).toContain("System Overview");
    expect(html).toContain("S&amp;S Activewear");
    expect(html).toContain("SanMar");
    expect(html).toContain("Unavailable");
    expect(html).toContain("Recent Refreshes");
    expect(html).toContain("Rollback History");
    expect(html).not.toContain("Catalog Unavailable");
  });

  it("uses the generic unavailable screen only when the overview cannot load", () => {
    const overview = partialOverview();
    overview.available = false;
    overview.reason = "The vendor catalog overview is unavailable.";

    const html = renderToStaticMarkup(<AdminDashboard overview={overview} />);

    expect(html).toContain("Catalog Unavailable");
    expect(html).toContain("The vendor catalog overview is unavailable.");
    expect(html).not.toContain("System Overview");
  });

  it("labels failed optional sections without hiding healthy catalog data", () => {
    const overview = partialOverview();
    overview.recentJobs = [];
    overview.rollbackSummary = {
      ss: { totalCount: 0, latestAt: null },
      sanmar: { totalCount: 0, latestAt: null },
    };
    overview.sectionAvailability = {
      recentJobs: false,
      rollbackSummary: false,
    };

    const html = renderToStaticMarkup(<AdminDashboard overview={overview} />);

    expect(html).toContain("System Overview");
    expect(html).toContain("Refresh history unavailable.");
    expect(html).toContain("Rollback history unavailable.");
    expect(html).not.toContain("No refresh history available.");
    expect(html).not.toContain("Catalog Unavailable");
  });
});
