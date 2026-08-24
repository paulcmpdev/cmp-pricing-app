# PRD: DTF Tier-Margin Editor and Calculated Draft Preview

Date: 2026-08-24
Status: Proposed for implementation
Owner: Paul Sanford

## Problem Statement

CMP's pricing app uses a verified but frozen JSON snapshot captured from the live pricing Google Sheet. Paul cannot inspect or test a tier-margin change inside the app, and changes to the Sheet do not propagate to Quote Desk. This makes pricing maintenance slow, opaque, and dependent on code changes.

The first release should let Paul edit T1-T4 gross-margin targets by quantity tier and immediately see the calculated price and quote impact, without saving or publishing anything.

## Goals

1. Make the current DTF tier structure, margin policy, and calculated prices understandable inside Admin.
2. Let Paul change any tier/lane gross-margin percentage in a temporary draft.
3. Recalculate the affected tier price using the same rules as the live Google Sheet.
4. Show current versus draft price, achieved margin, and quote impact before any future publication workflow exists.
5. Prove exact baseline parity with all 23 tiers and all four lanes from the live Sheet.

## Non-Goals

1. **No production pricing writes.** Authentication and RBAC do not exist yet.
2. **No database persistence.** The v1 draft is session-only and resets on refresh.
3. **No file upload.** Printavo-style CSV/XLSX import is a later phase.
4. **No editing operational inputs.** Wages, overhead, throughput, sheet prices, transfer geometry, shared labor, multiplier, commission, and rounding are read-only in v1.
5. **No editing tier boundaries.** Quantity ranges remain fixed and contiguous in v1.
6. **No Quote Desk activation.** The existing bundled contract remains the only pricing source used by quotes.
7. **No Manager/Admin quote-lane override.** That requires authenticated RBAC.

## Personas

### Paul, Pricing Administrator

As Paul, I want to edit one gross-margin target and see the price and quote effects immediately, so I can evaluate pricing decisions without changing the Google Sheet or deploying code.

### Future Manager

As a future authenticated Manager, I want to understand the active matrix and compare approved pricing lanes. This persona is considered in the design but receives no write or override capability in v1.

## Existing Pricing Contract

The application currently reads `lib/fixtures/pricing-contract.json` directly from server-side pricing modules.

Relevant current defaults:

- Product cost multiplier: 2.00
- Commission reserve: 8%
- Rounding increment: $0.05 upward
- Staff DTF lane: T1
- T1 margin: 50%
- T2 margin: 45%
- T3 margin: 40%
- T4 margin: 35%
- Active Impress mode: Average
- Shared labor policy: Tier-Based
- Shared project labor: $36.515 per order
- Transfer size: 10 x 10 inches
- Sheet width: 22 inches
- Spacing: 0.25 inch

## User Experience

### Admin Navigation

Add a disabled-by-default preview destination:

```text
Admin
  Catalog Operations
  Pricing Preview
```

The Pricing Preview is available only in local development or an explicitly protected preview environment. Production remains read-only unless a future authenticated authorization boundary is present.

### Page Sections

#### 1. Pricing Context

Display read-only values:

- Contract source and schema version
- Product multiplier
- Commission reserve
- Rounding increment
- Active Impress mode
- Shared-labor pricing mode
- Shared project labor
- Transfer dimensions

#### 2. Tier-Margin Grid

Columns:

| Quantity Tier | Min | Max | Base DTF COGS | At-Cost Labor | T1 Margin | T1 Price | T2 Margin | T2 Price | T3 Margin | T3 Price | T4 Margin | T4 Price |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|

Behavior:

- Quantity tier, min, max, cost components, and calculated prices are read-only.
- T1-T4 margin percentages are editable.
- Entering `35` means 35%, not 0.35%.
- The active value and draft value are visually distinct.
- Changed cells show a dirty-state indicator.
- Only the edited tier/lane price changes.
- Reset Cell restores one margin.
- Reset All restores the complete active contract.

#### 3. Calculation Trace

Selecting a tier/lane shows:

```text
Base DTF COGS
Target gross margin
Margin-loaded price
At-cost Tier-Based labor recovery
Raw calculated price
Rounding increment
Final calculated price
Achieved gross margin after rounding
```

#### 4. Quote Impact Preview

Inputs:

- Product cost
- Quantity
- Margin lane

Outputs:

- Current product sell
- Current decoration sell
- Current unit price
- Current order total
- Draft decoration sell
- Draft unit price
- Draft order total
- Dollar and percentage change
- Commission reserve comparison
- Contribution comparison when internal COGS is available

This simulator never calls or mutates the production quote path.

## Calculation Requirements

Use decimal/fixed-point arithmetic. Do not use binary floating-point for published display values.

### Tier-Based Mode

```text
Tier Labor Recovery = Shared Project Labor / Tier Minimum Quantity
Base DTF COGS = Active Total DTF COGS - Tier Labor Recovery
Raw Price = Base DTF COGS / (1 - Target Gross Margin)
            + Tier Labor Recovery
Final Price = round upward to Rounding Increment
```

For single-piece tiers 1-11, tier minimum equals the exact quantity.

### Rounding

```text
Final Price = CEILING(Raw Price / Increment) * Increment
```

Current increment: $0.05.

### Product and Quote Preview

```text
Product Sell = Product Cost * Product Cost Multiplier
Unit Price = Product Sell + Decoration Sell
Order Total = Unit Price * Quantity
Commission Reserve = Unit Price * Commission Rate
```

## Functional Requirements

### P0 Must Have

- [ ] Read the current bundled pricing contract server-side.
- [ ] Render all 23 quantity tiers from 1 through 5,000.
- [ ] Render editable T1-T4 margin controls for every tier.
- [ ] Reproduce all 92 baseline tier/lane prices from the current contract and live Sheet.
- [ ] Recalculate immediately after a margin edit.
- [ ] Show current versus draft price and delta.
- [ ] Show a detailed calculation trace.
- [ ] Provide a quote impact simulator.
- [ ] Support Reset Cell and Reset All.
- [ ] Warn before navigating away with unsaved session changes.
- [ ] Discard the draft on refresh.
- [ ] Keep Quote Desk pricing unchanged.
- [ ] Keep all public APIs free of supplier cost and internal COGS fields.
- [ ] Hide or disable the preview in unprotected production.

### P1 Fast Follow

- Persist draft versions in PostgreSQL.
- Add Google authentication and roles.
- Add validation and approval states.
- Compare draft against active across canonical quote scenarios.
- Export draft as JSON/CSV.
- Record pricing-version provenance on quotes.
- Enforce Staff T1 and price-sensitive request inputs server-side.

### P2 Future

- Publish and rollback immutable pricing releases.
- Edit operational inputs.
- Edit flat fees and packages.
- Edit print-size references.
- Edit additional-location matrices.
- Edit bag-patch matrices.
- Import/export Printavo-style CSV/XLSX.
- Support archived Screen Print matrices if reactivated.
- Manager/Admin T1-T4 quote override after authenticated RBAC.

## Validation Rules

- Margin must be numeric.
- Margin must be greater than or equal to 0% and less than 100%.
- Display a strong warning below 20% or above 70%, but do not invent a policy block without Paul's approval.
- Quantity tiers are read-only in v1.
- Tiers must remain contiguous and non-overlapping in contract validation.
- The full supported range remains 1 through 5,000.
- Any missing cost component, non-finite result, or non-positive calculated price fails closed.
- Draft calculation errors must not fall back to the current price silently.

## Acceptance Tests

### Baseline Parity

Given the unedited current contract, when the editor calculates every tier and lane, then all 92 prices match the captured matrix exactly to the $0.05 increment.

Required examples:

- 72-143: T1 $6.55, T2 $6.00, T3 $5.55, T4 $5.15
- 144-249: T1 $6.00, T2 $5.45, T3 $5.05, T4 $4.65

### Margin Edit

Given tier 72-143, when Paul enters `35` in T4, then the field is interpreted as 35% and the calculated price is $5.15 under the current contract.

Given any one tier/lane is changed to another valid percentage, then only that calculated tier/lane price changes.

### Quote Preview

Given product cost $4.80, quantity 174, and lane T1, then the current preview shows:

- Product Sell: $9.60
- Decoration Sell: $6.00
- Unit Price: $15.60
- Order Total: $2,714.40

### Isolation

Given a draft margin edit, when Quote Desk is used in another tab, then Quote Desk continues using the bundled active contract and is unaffected.

### Security

Given an unprotected production environment, when a user requests Pricing Preview, then internal pricing details are not rendered.

## Success Metrics

### Leading

- 100% parity across 92 baseline tier/lane prices.
- A single margin edit produces a preview in under 100 milliseconds after input debounce.
- Zero production pricing changes from preview usage.
- Paul can evaluate a tier-margin change without opening the Google Sheet.

### Lagging

- Reduced time to evaluate and approve pricing changes.
- Fewer pricing discrepancies caused by manual spreadsheet-to-code transfer.
- No untraceable production price changes after persistent publication is introduced.

## Risks

1. The current JSON stores calculated matrix outputs but not every original Sheet formula component. V1 must reconstruct and verify the Tier-Based formula against all 92 prices before UI work is accepted.
2. The app currently trusts some client-supplied price-sensitive request fields. Persistent pricing publication must not ship before server-side policy enforcement is corrected.
3. The current Admin page has no authenticated authorization boundary. Internal pricing data must remain protected.
4. A spreadsheet clone would blur inputs, policies, and outputs. The UI must clearly distinguish editable margins from calculated prices.
5. The Google Sheet contains multiple matrix families and hidden engines. V1 is intentionally limited to the DTF base matrix.

## Dependencies

- Existing `pricing-contract.json`
- Existing decimal/money utilities
- Existing DTF tier and optimizer tests
- Protected local or Vercel preview environment
- Google Sheet used as read-only parity reference

## Open Questions After v1

- App database versus Google Sheet as long-term source of truth
- Authentication and role implementation timing
- Persistent draft schema and approval workflow
- Exact Printavo import/export file format
- Ordering of matrix families after DTF base pricing
