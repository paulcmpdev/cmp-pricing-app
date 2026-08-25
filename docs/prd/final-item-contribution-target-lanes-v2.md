# PRD: Final-Item Contribution Target Lanes v2

Date: 2026-08-25
Status: Rejected and rolled back. Do not implement.

The live Sheet experiment produced materially uncompetitive prices. CMP restored T1–T4 as decoration gross-margin lanes. Post-commission contribution remains a visible audit output, not a direct pricing target.

## Outcome

Change the CMP pricing app so T1–T4 directly target final-item contribution margin after the 8% commission reserve. Eliminate decoration-margin trial and error.

## Lane policy

| Lane | Target contribution margin after commission |
|---|---:|
| T1 | 50% |
| T2 | 45% |
| T3 | 40% |
| T4 | 35% |

## Required calculation

Inputs:

- Product COGS
- Product Sell under the active product multiplier
- Base Decoration COGS
- Every selected Additional Location COGS
- Approved component floors and overrides
- Commission rate
- Target lane
- Rounding increment

```text
Total COGS = Product COGS
           + Base Decoration COGS
           + sum(Additional Location COGS)

Required Target Price =
Total COGS ÷ (1 − Commission Rate − Target Contribution Margin)

Component Floor Price = Product Sell
                      + sum(Additional Location Effective Prices)

Final Item Price = round upward(max(Required Target Price, Component Floor Price))

Commission Reserve = Final Item Price × Commission Rate
Contribution = Final Item Price − Total COGS − Commission Reserve
Achieved Contribution Margin = Contribution ÷ Final Item Price
```

Use decimal-safe calculations. Apply the configured upward rounding increment at the final pricing boundary and recompute achieved contribution from the rounded result.

## Quote Desk

- T1 remains the staff default.
- The selected lane represents final-item contribution target, not decoration margin.
- Multiple Additional Locations are included in Total COGS and component price floors before solving the final price.
- Show target contribution margin and achieved contribution margin.
- Show which basis determined the price:
  - `Target contribution`
  - `Product / fixed service floor`
- Preserve Product Sell, Base Decoration, and each Additional Location as visible composition lines.
- Base Decoration is the non-negative remainder after Product Sell, fixed Additional Location prices, and any Contribution Target Adjustment. Do not impose the legacy 40% decoration gross-margin floor.

## Admin preview

- Rename editable controls from decoration margin to final-item contribution target.
- Default lane targets are 50%, 45%, 40%, and 35%.
- Quote impact requires product cost and quantity.
- Optional Additional Locations are included in quote impact.
- A static decoration-only grid may remain as a baseline/reference but must not claim its percentages guarantee the final-item contribution target.
- Show current bundled-contract quote versus draft target quote.
- Session-only; no save or publish.

## Additional Location Matrix

The workbook-derived Additional Location Matrix remains a separate component reference. Its internal component margin controls are not T1–T4 quote-level targets and must be labeled explicitly if exposed.

In this release:

- Display its 104 captured component rows for audit.
- Do not present its legacy margin percentages as final-item contribution targets.
- Any component-price editing must remain session-only and clearly separated from quote-level T1–T4 targets.

## Security

- Protected preview only.
- Hard-block the new COGS and target solver when `VERCEL_ENV=production`.
- Existing public production Quote Desk and API projections remain unchanged.

## Verification

- Algebraic tests prove each lane meets or exceeds its target after final rounding.
- Tests cover 15% T4 targets, Product Sell floors, and fixed Additional Location service floors.
- Tests cover product-cost changes with fixed quantity/COGS.
- Tests cover zero, one, and multiple Additional Locations.
- Tests prove commission remains separate from the product multiplier.
- Tests prove achieved contribution is recomputed from final rounded values.
- Existing public production behavior remains unchanged.
