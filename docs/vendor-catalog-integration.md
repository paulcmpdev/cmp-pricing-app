# Vendor Catalog Pricing Integration

## Goal

Let Quote Desk search and price any S&S Activewear or SanMar product from CMP's downloaded Vendo catalog without sending vendor costs to the browser in Staff mode.

## Verified source state

- Vendo source: `/Users/paulsanford/vendo-server`
- Downloaded PostgreSQL volume: `vendo-server_postgres_data`
- S&S: 221,824 SKU variants across 6,381 styles; all rows have piece price, customer price, and inventory quantity.
- SanMar: 151,573 priced variants across 3,953 styles; 151,486 rows have piece, dozen, and case prices.
- Latest successful S&S full sync: 2025-09-09. A 2026-06-15 refresh failed on a duplicate `ss_styles` primary key.
- Latest completed SanMar sync: 2026-06-29 with nine recorded errors.
- Official S&S API documentation defines `customerPrice` as “Your price.”

The snapshot is useful for a proof, but it is not current enough to silently treat as live vendor truth.

## Architecture

1. Import Vendo into a calculator-owned canonical SQLite snapshot. Do not query Vendo tables directly from quote math.
2. Keep the full snapshot out of Git. Configure its path with `VENDOR_CATALOG_DB_PATH`.
3. Preserve the existing 45-product CMP catalog as a fallback and separate product mode.
4. Add server-only repository functions for style search, style variants, and variant cost resolution.
5. Return style, color, size, inventory, image, vendor, and source freshness to the client. Never return cost fields from catalog search/variant APIs.
6. Resolve cost again on the server when a quote request submits a canonical variant ID.
7. Use conservative default cost bases:
   - S&S: `piecePrice` (the regular S&S price). `customerPrice` and `salePrice` are stored for audit only.
   - SanMar: `casePrice`.
8. Return cost basis and snapshot provenance only in Manager quote responses.
9. Mark stale source snapshots visibly. Do not label snapshot inventory or prices as live.
10. A future saved quote must persist supplier, source variant ID, style, color, size, resolved unit cost, cost basis, source sync timestamp, and quote timestamp.

## Canonical data contract

### catalog_sources

- vendor
- source_sync_at
- imported_at
- source_status
- source_errors
- variant_count
- style_count

### catalog_styles

- id (`ss:<styleID>` or `sanmar:<style>`)
- vendor
- source_style_id
- style_code
- brand
- name
- category
- description
- image_url
- active_variant_count
- source_sync_at

### catalog_variants

- id (`ss:<sku>` or `sanmar:<uniqueKey>`)
- style_id
- vendor
- source_variant_id
- style_code
- color
- size
- size_order
- inventory_qty (nullable for SanMar snapshot)
- image_url
- discontinued
- piece_price
- dozen_price
- case_price
- sale_price
- customer_price
- resolved_cost
- cost_basis
- source_sync_at

All monetary fields remain server-only.

## API contract

- `GET /api/vendor-catalog/search?q=<term>&vendor=<all|ss|sanmar>`
  - Require at least two non-space characters.
  - Return at most 25 style summaries.
  - Exact style matches rank before prefix, then substring/name matches.
  - No cost fields.
- `GET /api/vendor-catalog/styles/<style-id>/variants`
  - Return public variant fields only.
  - No cost fields.
- `POST /api/quote/item`
  - Continue accepting existing CMP `sku` and manual `productCost` paths.
  - Add `catalogVariantId` as a mutually exclusive server-resolved path.
  - Staff response contains no cost or cost-basis fields.
  - Manager response may include unit cost, basis, vendor, variant, and freshness provenance.

## Quote Desk flow

Add a third product mode without breaking existing behavior:

1. CMP Catalog
2. Vendor Catalog
3. Manual Cost

Vendor Catalog flow:

1. Search by style, brand, or product name.
2. Optionally filter S&S or SanMar.
3. Select a style result.
4. Select color.
5. Select size.
6. Show inventory when available, source date, and stale-snapshot warning.
7. Send only the canonical variant ID to the quote API.

Do not load the full catalog into the browser.

## Acceptance criteria

- Search works against the full imported S&S and SanMar snapshot.
- Style `3001` from S&S and style `K500` from SanMar can be selected and quoted end to end.
- Search and variant JSON contain no prices, COGS, `resolved_cost`, or internal pricing fields.
- Staff quote JSON contains no product unit cost or cost basis.
- Manager quote JSON includes source provenance for a vendor variant.
- Existing CMP catalog and manual-cost paths continue working.
- Missing database configuration falls back cleanly and explains that vendor catalog is unavailable.
- Empty query, short query, no results, loading, stale source, unavailable database, and server error states are covered.
- Keyboard navigation, labels, focus, and mobile layout are verified.
- Import counts reconcile to source counts and invalid-price rows are reported, not invented.
- Unit tests, typecheck, lint, build, and Playwright pass.

## Production boundary

This proof may run locally against a calculator-owned SQLite snapshot. A cloud deployment needs:

- A managed database or object-backed snapshot available to Vercel functions.
- A repeatable refresh job with count/freshness/error monitoring.
- Fixed S&S upsert logic and a successful current sync.
- Current SanMar refresh with error reconciliation.
- Server-side authentication for Manager mode.
- Explicit approval before deployment or external sharing.
