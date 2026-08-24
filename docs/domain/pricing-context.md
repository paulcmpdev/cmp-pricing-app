# Context: CMP Pricing Administration

## Purpose

CMP Pricing Administration is the internal control surface for understanding, testing, versioning, and eventually publishing the pricing rules used by Quote Desk.

The first release is a protected, session-only DTF tier-margin editor and calculated preview. It does not save or publish changes.

## Current Reality

- Vendor product catalogs and resolved supplier costs are stored in PostgreSQL.
- Pricing assumptions and calculated matrices are not stored in PostgreSQL.
- The active application pricing contract is a source-controlled snapshot at `lib/fixtures/pricing-contract.json`.
- The contract was captured from the live Google Sheet titled `CMP Screen Print Labor & Internal COGS Builder`.
- Editing the Google Sheet does not update the deployed application.
- Updating the application pricing contract currently requires a code change, tests, and deployment.
- `/admin` is currently a read-only catalog-operations dashboard and has no authenticated identity or role boundary.

## Glossary

### Pricing Contract

The complete typed snapshot of pricing assumptions, policies, matrix outputs, geometries, services, and calculation provenance used by a deployed app build.

- Current code reference: `lib/fixtures/pricing-contract.json`
- Not: the vendor product catalog
- Not: one customer quote

### Operational Input

An editable cost or production assumption that affects calculated COGS.

Examples:

- Operator wage
- Facility overhead
- Throughput
- Gang-sheet dimensions and prices
- Transfer dimensions and spacing
- Shared operational labor

Operational inputs are not customer-facing prices.

### Pricing Policy

A business rule that converts cost into a selling price or controls quote behavior.

Examples:

- Product cost multiplier
- Commission reserve
- Rounding increment
- Quantity tiers
- T1-T4 gross-margin targets
- Staff default lane
- Minimum billable quantity

### Quantity Tier

A contiguous inclusive quantity range used to select pricing policy and calculated prices.

Current tiers cover quantities 1 through 5,000. Quantities above 5,000 require manager review.

### Margin Lane

One of four pricing-policy columns used for DTF decoration prices.

Current policy:

| Lane | Target decoration gross margin | Staff behavior |
|---|---:|---|
| T1 | 50% | Default |
| T2 | 45% | Future authenticated Manager/Admin override |
| T3 | 40% | Future authenticated Manager/Admin override |
| T4 | 35% | Future authenticated Manager/Admin override |

A margin lane is not an Impress operating mode.

### Calculated Tier Price

A customer-facing decoration price produced from COGS, target gross margin, labor-recovery policy, and rounding.

Calculated tier prices are outputs. They should not be edited directly when their governing inputs and policies are available.

For the current Tier-Based labor policy:

```text
Base DTF COGS = Active Total DTF COGS - Tier-Based Labor Recovery
Raw Decoration Price = Base DTF COGS / (1 - Target Gross Margin)
                       + Tier-Based Labor Recovery
Calculated Tier Price = round upward to the configured increment
```

### Draft Preview

A temporary set of pricing edits used to calculate and compare effects without changing Quote Desk.

In v1, the draft exists only in browser memory and is discarded on refresh.

### Active Pricing Version

The immutable pricing release used by Quote Desk.

This concept does not exist in the database yet. The deployed JSON contract acts as the effective active version.

### Matrix Import

A CSV or XLSX file parsed into a draft pricing version for validation and comparison.

An import must never publish automatically.

## Core Relationships

- A Pricing Contract contains Operational Inputs and Pricing Policies.
- A DTF matrix contains many Quantity Tiers.
- Each Quantity Tier has one target margin and one calculated price for every Margin Lane.
- A Draft Preview is based on one active Pricing Contract.
- A future published Pricing Version must be immutable and atomically activated.
- A customer quote must eventually record the Pricing Version used to calculate it.

## Lifecycle

### v1 Preview Lifecycle

```text
active bundled contract -> session draft -> calculated preview -> reset/discard
```

No save or publish operation exists.

### Future Persistent Lifecycle

```text
draft -> validating -> ready -> published -> superseded -> archived
```

Published versions are immutable. Publication moves one active pointer atomically and preserves rollback metadata.

## Security Boundary

- The current application has no authenticated server-derived identity or role.
- Client headers are not authorization.
- Pricing writes and production publication remain disabled until Google authentication and RBAC exist.
- Staff pricing policy must be enforced server-side before persistent pricing publication ships.
- Supplier costs and internal COGS must not be exposed through public quote or catalog APIs.

## Source Precedence

During v1:

1. `pricing-contract.json` is the application baseline.
2. The live Google Sheet is the authoritative reference for parity review and missing input lineage.
3. Browser edits are temporary preview data only.

The long-term authoritative source for persistent pricing has not yet been decided. The recommended direction is an app-owned versioned database, with Sheets and Printavo files used for import, reference, and export.

## Open Questions

- Should the future app database replace the Google Sheet as the pricing source of truth?
- Which roles may create drafts, validate, publish, and rollback?
- Should tier boundaries remain fixed or become editable after v1?
- Which Printavo import/export format is authoritative for CMP?
- Which matrix family follows DTF base pricing after v1: flat fees, additional locations, bag patches, or product policies?
