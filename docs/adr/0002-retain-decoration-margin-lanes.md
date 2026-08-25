# ADR 0002: Retain decoration-margin lanes and audit contribution

Date: 2026-08-25
Status: Accepted

## Context

CMP tested reinterpreting T1–T4 as final-item post-commission contribution targets. The experiment materially increased standard T1–T3 prices and made the matrix uncompetitive. The live Sheet was restored against the verified pre-experiment workbook and Stephanie-approved Printavo matrix.

## Decision

- T1–T4 remain DTF decoration gross-margin lanes: 50%, 45%, 40%, and 35%.
- Product Sell remains Product COGS × 2.00.
- Commission remains a separate 8% reserve on the final combined selling price.
- Post-commission contribution and contribution margin remain visible audit outputs.
- Contribution does not directly set or adjust the customer price.
- Quote Desk Additional Locations use the existing approved flat-fee service prices additively.

```text
Final Per-Item Price =
Product Sell
+ Base Decoration Sell
+ sum(Additional Location Effective Prices)
```

```text
Total COGS =
Product COGS
+ Base Decoration COGS
+ sum(Additional Location COGS)
```

The app recomputes commission, gross profit, contribution, and margins from those final totals without adding a Contribution Target Adjustment.

## Consequences

- Existing competitive pricing and Printavo parity are preserved.
- Managers can edit decoration-margin controls and inspect quote impact.
- A low or undesirable post-commission contribution is surfaced as an audit result or warning, not silently corrected by increasing price.
- ADR 0001 and its PRD remain rejected historical records and must not be implemented.