# PRD: Additional Locations and Quote Desk Cost Breakdown v1

Date: 2026-08-25
Status: Approved for implementation

## Outcome

Replace Quote Desk’s single detached Add-On Service workflow with an Additional Locations workflow that supports multiple approved flat-fee services, includes every selected location in the per-item selling price, and exposes a complete COGS breakdown to sales staff inside a protected preview.

Add a separate Admin session-only editor for the workbook-derived Additional Location Matrix.

## Agreed domain language

### Base Decoration

The one included DTF placement already represented by `Decoration Sell` and `Base Decoration COGS`.

### Additional Location

One selected service from the existing nine approved flat-fee services. It applies to the full item quantity and adds one service price per item.

Additional Location is the user-facing replacement for `Add-On Service`. Internal flat-fee engine names may remain during migration.

### Additional Locations total

The sum of all selected Additional Location effective prices per item.

```text
Additional Locations Sell / Item = sum(selected service effective prices)
```

### Final Per-Item Price

```text
Final Per-Item Price = Product Sell
                     + Base Decoration Sell
                     + Additional Locations Sell / Item
```

Product Sell and Base Decoration Sell remain the approved existing Quote Desk outputs. Additional Locations are additive fixed service prices. This release must not add a contribution-target solver, pricing adjustment, or reinterpret T1–T4.

### COGS breakdown

The protected Quote Desk must show:

```text
Product COGS
Base Decoration COGS
Each Additional Location COGS
Total COGS / Item
```

```text
Total COGS / Item = Product COGS
                  + Base Decoration COGS
                  + sum(each Additional Location engine COGS)
```

Each flat-fee service remains priced independently under its current engine price, policy floor, and manual override. v1 does not re-optimize several selected services as one new package.

### Additional Location Matrix

The workbook-derived quantity-tier matrix is a separate Admin pricing-preview surface. It is not the Quote Desk’s nine-service flat-fee menu.

The matrix contains:

- 13 active print/location types
- 8 quantity tiers per type
- COGS per piece
- T1–T4 calculated prices
- Global editable margin controls:
  - T1 58%
  - T2 52%
  - T3 44%
  - T4 35%

Draft price formula:

```text
Raw Price = COGS per piece / (1 - draft lane margin)
Draft Price = round upward to $0.05
```

## Quote Desk requirements

1. Rename `Add-On Service` to `Additional Locations`.
2. Start with no selected locations.
3. A `+ Add Location` control adds a location row.
4. Every row selects one of the existing nine approved flat-fee services.
5. Every location uses the main item quantity. There is no location-level quantity input.
6. Rows can be removed.
7. Multiple rows may select different services.
8. Duplicate selections are invalid and must be prevented or clearly rejected.
9. Changing item quantity recalculates every selected location.
10. Per-item summary lists:
    - Product Sell
    - Base Decoration Sell
    - One line for each Additional Location
    - Final Per-Item Price
11. Order total equals Final Per-Item Price × item quantity.
12. Recalculate combined commission, gross profit, net contribution, gross margin, and post-commission contribution margin as audit outputs from the final additive price and complete COGS.
13. Mobile sticky per-item and order totals use the final combined totals.
14. Staff can see the full COGS breakdown in the protected preview.
15. Loading, stale-response, removal-during-request, API failure, and quantity-validation states must not display stale totals.

## Admin matrix requirements

1. Add an `Additional Location Matrix` surface beside the existing `DTF Base Matrix` preview.
2. Display all 104 captured matrix rows: 13 locations × 8 tiers.
3. Display current COGS and current T1–T4 prices.
4. Allow session-only editing of the four global component-margin controls, labeled explicitly as component pricing inputs rather than T1–T4 final-item targets.
5. Recalculate all affected component prices immediately.
6. Display current versus draft values and deltas.
7. Provide Reset Lane and Reset All.
8. Warn before leaving with unsaved session edits.
9. Clearly state that edits are not saved or published.
10. No database, save, publish, upload, or production-pricing mutation.

## Source of truth

- Live workbook: `CMP Screen Print Labor & Internal COGS Builder`
- Spreadsheet ID: `1dtN83KQ2ERy6nozPJe65InaRvq0ydCdvUllTH9DtW9c`
- Source tab: `Additional Location Matrix`
- Captured fixture: `lib/fixtures/additional-location-matrix.json`
- Captured rows: 104

The existing nine flat-fee services, floors, overrides, geometries, and pooled calculations remain sourced from `lib/fixtures/pricing-contract.json`.

## Security and deployment boundary

The production Quote Desk is currently publicly reachable and must not expose COGS.

This entire v1 feature must be gated by a server-enforced environment flag and unavailable when `VERCEL_ENV=production`, even if the flag is mistakenly set.

Expected behavior:

- Protected Vercel Preview + flag enabled: new Quote Desk workflow and COGS are available.
- Production: existing Quote Desk behavior and staff-safe API projections remain unchanged.
- Unflagged preview/local: protected feature routes return 404 or the existing UI remains unchanged.
- Client headers are not authorization.
- Protected COGS projection is returned independently by the server when the Additional Locations preview env gate is enabled; access relies on Vercel Deployment Protection plus the server flag, not `x-cmp-role`.

## Explicit deferrals

- Saved drafts or publishing
- Database-backed pricing versions
- Authentication and RBAC
- Production COGS exposure
- Editing location dimensions, tier boundaries, COGS, service floors, or overrides
- Repricing Quote Desk’s nine flat-fee services from the separate quantity-tier matrix
- Combined gang-sheet re-optimization across several selected flat-fee services
- Guided Builder and Command Center redesigns

## Acceptance verification

- Fixture count: 104 unique location/tier rows across 13 keys and 8 tiers.
- Workbook parity for all 416 current lane prices.
- Margin edits recalculate all 104 affected cells per lane with upward $0.05 rounding.
- Quote Desk supports add, select, remove, and multiple locations.
- Final per-item and order totals reconcile exactly.
- COGS components reconcile exactly.
- Duplicate location services are rejected.
- Production and unflagged gates are verified.
- Unit, API, TypeScript, lint, production build, Playwright, desktop, tablet, and mobile checks pass.
