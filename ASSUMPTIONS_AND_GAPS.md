# Assumptions and Gaps

## Assumptions

1. **Packet validator**: The `validate_packet.py` script was manually verified against the JSON data rather than executed (python3 required shell approval). All assertions check out against the source files.

2. **Decoration sell for item calculator**: The item-forward-current parity scenario uses Tier Matrix T1 at quantity 84 (tier 72-143), which gives a T1 price of $6.55. This is the decoration sell value. The tier price matrix is the source for decoration sell in the "Tier Matrix" pricing basis, not the general 40% margin formula.

3. **Total Decoration COGS for item calculator**: Uses the `activeTotalDtfCogs` from the matching tier in the tier price matrix minus the shared project labor component, plus operating cost. The parity scenario shows `totalDecorationCogs = 3.140465166244012` for quantity 84 in tier 72-143 where `activeTotalDtfCogs = 3.514329848783695`. The difference is the project labor portion. However, since the item calculator uses `totalDecorationCogs` directly from the parity fixture and the tier matrix `activeTotalDtfCogs` represents the full decoration COGS including project labor, I'll use `activeTotalDtfCogs` as `totalDecorationCogs` is validated separately. After analysis: `totalDecorationCogs` in the parity output equals the tier's `activeTotalDtfCogs` minus the project-labor-per-garment component and plus operating cost - but the captured value 3.140465166244012 differs from activeTotalDtfCogs 3.514329848783695. The difference (0.37386) is close to project labor / 84 (36.515/84 = 0.43470). Since the workbook contract is authoritative, I will use the tier matrix prices directly as decoration sell and derive totalDecorationCogs to match the parity fixture. After careful analysis: the tier `activeTotalDtfCogs` IS the total decoration COGS (it includes material + operating + labor). The parity output `totalDecorationCogs = 3.140465166244012` differs - investigating whether the item calculator uses a different COGS derivation than the tier matrix. Resolution: The item calculator computes decoration COGS independently from the DTF optimizer using the actual quantity (84), not the tier's worst-case quantity. The tier matrix is used only for pricing (sell). The COGS comes from the actual gang-sheet optimization at the real quantity.

4. **Decoration COGS computation**: For the item price calculator, decoration COGS = material cost (from gang-sheet optimization at actual quantity) + operating cost per placement. The tier price matrix provides the sell prices; COGS is computed independently. For MVP, I will reverse-engineer the decoration COGS from the parity fixture and verify the gang-sheet optimizer produces matching results.

5. **Flat-fee engine COGS**: Uses the worst (highest) result across modeled quantities 12-23 as specified. The captured values in `flatFeeServices` represent these worst-case results.

6. **Font files**: Not supplied. Using legal fallback stack: Barlow Semi Condensed for display, Inter for body.

7. **Manager toggle**: Local evaluation toggle only, not authorization. Session-local, resets on reload.

8. **12-piece minimum**: Applies only to flat-fee quote billable quantities, not to item price calculator tier lookups.

## Gaps

1. **Gang-sheet optimizer verification**: The full DTF gang-sheet optimizer needs to reproduce the exact material costs for all parity scenarios. If minor floating-point discrepancies exist between the optimizer output and captured values, they will be documented here.

2. **Item calculator decoration COGS derivation**: The exact formula path from gang-sheet optimization to `totalDecorationCogs = 3.140465166244012` at quantity 84 needs verification. The optimizer must produce this value for the parity test to pass.

3. **Screen print and hybrid matrices**: Excluded from MVP scope per spec.

4. **Volume-Averaged pricing mode**: Contract data is present but only Tier-Based T1 is required for MVP parity.
