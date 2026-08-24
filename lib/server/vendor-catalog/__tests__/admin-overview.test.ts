import { describe, expect, it, vi } from "vitest";
import { queryAdminCatalogOverview } from "../admin-overview";

function fakeDatabase(results: Record<string, unknown>[][]) {
  const query = vi.fn().mockImplementation(async () => ({
    rows: results.shift() ?? [],
  }));
  return { query };
}

function rows(): Record<string, unknown>[][] {
  return [
    [
      {
        vendor: "ss",
        active: true,
        active_import_status: "active",
        style_count: 2,
        variant_count: 3,
        source_status: "completed",
        source_errors: 0,
        source_sync_at: new Date("2026-08-20T10:00:00.000Z"),
        imported_at: new Date("2026-08-20T10:05:00.000Z"),
        activated_at: new Date("2026-08-20T10:10:00.000Z"),
        canary_style_rows: 1,
        canary_variant_rows: 2,
        active_job_status: null,
      },
      {
        vendor: "sanmar",
        active: true,
        active_import_status: "active",
        style_count: 1,
        variant_count: 2,
        source_status: "completed",
        source_errors: 0,
        source_sync_at: new Date("2026-08-21T10:00:00.000Z"),
        imported_at: new Date("2026-08-21T10:05:00.000Z"),
        activated_at: new Date("2026-08-21T10:10:00.000Z"),
        canary_style_rows: 1,
        canary_variant_rows: 2,
        active_job_status: null,
      },
    ],
    [
      {
        vendor: "ss",
        status: "completed",
        phase: "completed",
        attempts: 1,
        created_at: new Date("2026-08-22T10:00:00.000Z"),
        started_at: new Date("2026-08-22T10:01:00.000Z"),
        completed_at: new Date("2026-08-22T10:02:00.000Z"),
      },
      {
        vendor: "sanmar",
        status: "running",
        phase: null,
        attempts: 2,
        created_at: new Date("2026-08-22T09:00:00.000Z"),
        started_at: null,
        completed_at: null,
      },
    ],
    [
      {
        vendor: "ss",
        total_count: 2,
        latest_at: new Date("2026-08-22T11:00:00.000Z"),
      },
      {
        vendor: "sanmar",
        total_count: 0,
        latest_at: null,
      },
    ],
  ];
}

describe("admin catalog overview", () => {
  it("maps active vendor rows into the safe overview contract", async () => {
    const database = fakeDatabase(rows());

    const overview = await queryAdminCatalogOverview(
      database,
      new Date("2026-08-23T12:00:00.000Z")
    );

    expect(overview.available).toBe(true);
    expect(overview.backend).toBe("postgres");
    expect(overview.generatedAt).toBe("2026-08-23T12:00:00.000Z");
    expect(overview.vendors.ss).toEqual({
      label: "S&S Activewear",
      active: true,
      health: "healthy",
      activeImportStatus: "active",
      styleCount: 2,
      variantCount: 3,
      sourceStatus: "completed",
      sourceErrors: 0,
      sourceSyncAt: "2026-08-20T10:00:00.000Z",
      importedAt: "2026-08-20T10:05:00.000Z",
      activatedAt: "2026-08-20T10:10:00.000Z",
      canaryStyleCode: "3001",
      canaryStyleRows: 1,
      canaryVariantRows: 2,
    });
    expect(overview.totals).toEqual({
      styleCount: 3,
      variantCount: 5,
      healthyVendorCount: 2,
    });
  });

  it("derives warning and unavailable health deterministically", async () => {
    const data = rows();
    data[0][0] = { ...data[0][0], source_errors: 1 };
    data[0][1] = {
      vendor: "sanmar",
      active: false,
      active_import_status: null,
      style_count: null,
      variant_count: null,
      source_status: null,
      source_errors: null,
      source_sync_at: null,
      imported_at: null,
      activated_at: null,
      canary_style_rows: 0,
      canary_variant_rows: 0,
      active_job_status: null,
    };

    const overview = await queryAdminCatalogOverview(fakeDatabase(data));

    expect(overview.vendors.ss.health).toBe("warning");
    expect(overview.vendors.sanmar.health).toBe("unavailable");
    expect(overview.vendors.sanmar.active).toBe(false);
    expect(overview.available).toBe(true);
    expect(overview.reason).toBeUndefined();
  });

  it("keeps core catalog health available when optional operational queries fail", async () => {
    const data = rows();
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: data[0] })
      .mockRejectedValueOnce(new Error("jobs table unavailable"))
      .mockRejectedValueOnce(new Error("rollback table unavailable"));

    const overview = await queryAdminCatalogOverview({ query });

    expect(overview.available).toBe(true);
    expect(overview.vendors.ss.styleCount).toBe(2);
    expect(overview.vendors.sanmar.variantCount).toBe(2);
    expect(overview.recentJobs).toEqual([]);
    expect(overview.rollbackSummary).toEqual({
      ss: { totalCount: 0, latestAt: null },
      sanmar: { totalCount: 0, latestAt: null },
    });
    expect(overview.sectionAvailability).toEqual({
      recentJobs: false,
      rollbackSummary: false,
    });
  });

  it("fails core catalog errors promptly without waiting for optional queries", async () => {
    const coreError = new Error("core catalog unavailable");
    const never = new Promise<{ rows: Record<string, unknown>[] }>(() => {});
    const query = vi
      .fn()
      .mockRejectedValueOnce(coreError)
      .mockReturnValueOnce(never)
      .mockReturnValueOnce(never);

    const outcome = await Promise.race([
      queryAdminCatalogOverview({ query }).then(
        () => "resolved",
        (error) => (error === coreError ? "core-rejected" : "other-error")
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timed-out"), 50)
      ),
    ]);

    expect(outcome).toBe("core-rejected");
  });

  it("sanitizes phases in SQL, orders and bounds recent jobs, and exposes no forbidden fields", async () => {
    const database = fakeDatabase(rows());

    const overview = await queryAdminCatalogOverview(database);
    const [vendorSql, vendorParams] = database.query.mock.calls[0];
    const [jobsSql] = database.query.mock.calls[1];

    expect(vendorSql).toContain("catalog_imports i");
    expect(vendorSql).toContain("i.status = 'active'");
    expect(vendorSql).toContain("v.import_id = ai.import_id");
    expect(vendorSql).toContain("v.style_id = cs.id");
    expect(vendorParams).toEqual([["queued", "running", "validating"]]);
    expect(jobsSql).toContain("LIMIT 8");
    expect(jobsSql).toContain("ORDER BY created_at DESC");
    expect(jobsSql).toContain("checkpoint->>'phase'");
    expect(jobsSql).toContain("ELSE NULL");
    expect(jobsSql).not.toMatch(/SELECT\s+\*/i);
    expect(jobsSql).not.toMatch(/\bid\b|error_summary|lease_owner|import_id/i);
    expect(jobsSql).not.toMatch(/\bcheckpoint\b\s*(,|\n\s*FROM)/i);

    const serialized = JSON.stringify(overview);
    expect(serialized).not.toMatch(
      /resolved_cost|cost_basis|source_metadata|error_summary|requested_by|lease_owner|checkpoint|import_id|job_id|audit_id/i
    );
  });

  it("rejects invalid timestamps and counts so the repository can fail closed", async () => {
    const badTimestamp = rows();
    badTimestamp[0][0] = { ...badTimestamp[0][0], source_sync_at: "not-a-date" };
    await expect(queryAdminCatalogOverview(fakeDatabase(badTimestamp))).rejects.toThrow(
      "Invalid catalog timestamp."
    );

    const badCount = rows();
    badCount[0][0] = { ...badCount[0][0], style_count: "NaN" };
    await expect(queryAdminCatalogOverview(fakeDatabase(badCount))).rejects.toThrow(
      "Invalid catalog count."
    );
  });
});
