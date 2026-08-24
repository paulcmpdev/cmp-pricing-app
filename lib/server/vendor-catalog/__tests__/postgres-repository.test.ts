import { describe, expect, it, vi } from "vitest";
import { createPostgresVendorCatalogRepository } from "../postgres-repository";

function fakeDatabase(rows: unknown[] = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query, database: { query } };
}

describe("PostgreSQL vendor catalog repository", () => {
  it("searches only active catalog versions with parameterized input", async () => {
    const { query, database } = fakeDatabase([
      {
        id: "ss:29",
        vendor: "ss",
        style_code: "3001",
        brand: "BELLA + CANVAS",
        name: "Jersey Tee",
        category: "T-Shirts",
        description: null,
        image_url: null,
        active_variant_count: 773,
        source_sync_at: new Date("2025-09-09T20:17:15.165Z"),
      },
    ]);
    const repository = createPostgresVendorCatalogRepository(database);

    const results = await repository.searchStyles({
      query: "3001%' OR true --",
      vendor: "ss",
    });

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("active_catalog_styles");
    expect(sql).not.toContain("3001%' OR true --");
    expect(params).toContain("ss");
    expect(results[0]).toMatchObject({
      id: "ss:29",
      styleCode: "3001",
      activeVariantCount: 773,
      sourceSyncAt: "2025-09-09T20:17:15.165Z",
    });
    expect(Object.keys(results[0]).join(" ")).not.toMatch(/cost|price|cogs/i);
  });

  it("returns public variants without selecting cost columns", async () => {
    const { query, database } = fakeDatabase([
      {
        id: "ss:sku",
        style_id: "ss:29",
        vendor: "ss",
        style_code: "3001",
        color: "Black",
        size: "M",
        size_order: 30,
        inventory_qty: 10,
        image_url: null,
        discontinued: false,
        source_sync_at: null,
      },
    ]);
    const repository = createPostgresVendorCatalogRepository(database);

    const variants = await repository.getStyleVariants("ss:29");

    const [sql] = query.mock.calls[0];
    expect(sql).not.toMatch(/resolved_cost|customer_price|piece_price/i);
    expect(Object.keys(variants[0]).join(" ")).not.toMatch(/cost|price|cogs/i);
  });

  it("resolves cost only through the server-side cost method", async () => {
    const { database } = fakeDatabase([
      {
        id: "sanmar:K500-RED-L",
        style_id: "sanmar:K500",
        vendor: "sanmar",
        style_code: "K500",
        color: "Red",
        size: "L",
        discontinued: false,
        resolved_cost: "9.7500",
        cost_basis: "casePrice",
        source_sync_at: new Date("2026-06-29T17:28:34.189Z"),
      },
    ]);
    const repository = createPostgresVendorCatalogRepository(database);

    await expect(repository.resolveVariantCost("sanmar:K500-RED-L")).resolves.toEqual({
      variantId: "sanmar:K500-RED-L",
      vendor: "sanmar",
      styleId: "sanmar:K500",
      styleCode: "K500",
      color: "Red",
      size: "L",
      discontinued: false,
      unitCost: 9.75,
      costBasis: "casePrice",
      sourceSyncAt: "2026-06-29T17:28:34.189Z",
    });
  });

  it("returns undefined for unknown variant", async () => {
    const { database } = fakeDatabase([]);
    const repository = createPostgresVendorCatalogRepository(database);

    await expect(repository.resolveVariantCost("ss:nope")).resolves.toBeUndefined();
  });

  it("returns empty array for short queries", async () => {
    const { query, database } = fakeDatabase([]);
    const repository = createPostgresVendorCatalogRepository(database);

    const results = await repository.searchStyles({ query: "X", vendor: "all" });

    expect(results).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("escapes LIKE wildcards in search input", async () => {
    const { query, database } = fakeDatabase([]);
    const repository = createPostgresVendorCatalogRepository(database);

    await repository.searchStyles({ query: "100%_off", vendor: "all" });

    const params = query.mock.calls[0][1];
    // The escaped LIKE parameters should not contain raw % or _
    expect(params[1]).toBe("100\\%\\_off%");
    expect(params[2]).toBe("%100\\%\\_off%");
  });

  it("handles null source_sync_at gracefully", async () => {
    const { database } = fakeDatabase([
      {
        id: "ss:1",
        vendor: "ss",
        style_code: "TEST",
        brand: null,
        name: null,
        category: null,
        description: null,
        image_url: null,
        active_variant_count: 0,
        source_sync_at: null,
      },
    ]);
    const repository = createPostgresVendorCatalogRepository(database);

    const results = await repository.searchStyles({ query: "TEST", vendor: "ss" });
    expect(results[0].sourceSyncAt).toBeNull();
  });
});
