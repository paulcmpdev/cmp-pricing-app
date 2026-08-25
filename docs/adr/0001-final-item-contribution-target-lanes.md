# ADR 0001: T1–T4 target final-item contribution after commission

Date: 2026-08-25
Status: Rejected and rolled back

> Rollback note: Live Sheet testing showed that final-item contribution targets made standard T1–T3 prices uncompetitively high. CMP restored the verified decoration-margin model and Stephanie-approved matrix on 2026-08-25. This ADR must not be implemented.

## Context

The current workbook labels per-tier controls `T1` through `T4` and currently uses them as base-decoration gross-margin inputs before commission. The Item Price Calculator separately computes the combined item contribution margin after reserving 8% commission.

That forces operators to adjust decoration percentages indirectly until the final item reaches the desired contribution margin. The controls therefore do not represent the business outcome Paul intends to manage.

A decoration-only percentage cannot guarantee one combined item margin across products because the final result also depends on product COGS, product sell, additional-location COGS and sell, shared labor, and commission.

## Decision

Inside the CMP pricing app, `T1` through `T4` are quote-level minimum targets for **final-item contribution margin after commission**:

| Lane | Target final-item contribution margin |
|---|---:|
| T1 | 50% |
| T2 | 45% |
| T3 | 40% |
| T4 | 35% |

The app solves required final price from the complete quoted COGS:

```text
Commission Reserve = Final Price × Commission Rate
Contribution = Final Price − Total COGS − Commission Reserve
Contribution Margin = Contribution ÷ Final Price

Required Final Price =
Total COGS ÷ (1 − Commission Rate − Target Contribution Margin)
```

The required final price is rounded upward under the configured pricing increment. The app then recomputes and displays the achieved contribution margin from the rounded price.

The final price is the greater of:

1. The price required to meet the target contribution margin.
2. Product Sell plus any explicitly approved fixed Additional Location service floors or overrides.

Base Decoration has no separate gross-margin floor. Its selling component is the non-negative remainder needed to reach the final-item target. Product margin may therefore subsidize Base Decoration while the complete quote still meets the selected post-commission contribution target.

`T1–T4` no longer mean decoration gross-margin targets in app UI, API, schemas, tests, or documentation.

## Component pricing

Product Sell remains `Product Cost × Product Multiplier`.

Base-decoration and Additional Location engines still calculate COGS. Additional Location services may retain explicitly approved fixed prices, policy floors, and overrides. Base Decoration does not retain the legacy 40% gross-margin floor in target-driven quote pricing.

## Consequences

Positive:

- The editable percentage directly represents the business outcome Paul wants.
- Quote Desk no longer requires trial-and-error adjustment of hidden decoration margins.
- Product cost, base decoration, multiple Additional Locations, commission, and shared labor are included in one target calculation.
- The achieved post-rounding contribution is visible and auditable.

Tradeoffs:

- Final pricing is product-specific; one universal decoration price cannot guarantee a quote-level target for every blank.
- Existing static matrix prices remain historical/reference outputs until the new quote-level solver is published.
- Admin preview needs quote context, including at minimum product cost, quantity, lane, and selected Additional Locations, to show a meaningful target price.
- Fixed Additional Location prices or Product Sell can produce achieved contribution above a very low selected lane target.

## Alternatives considered

- Keep T1–T4 as decoration gross margin: rejected because it requires indirect tuning and does not represent the desired final result.
- Make T1–T4 decoration contribution after commission: rejected because final item contribution would still vary with product cost and other components.
