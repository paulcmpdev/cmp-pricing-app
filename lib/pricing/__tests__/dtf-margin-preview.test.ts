import { describe, expect, it } from "vitest";
import contract from "@/lib/fixtures/pricing-contract.json";
import {
  DraftMarginInputSchema,
  calculateDtfMarginPreview,
  calculateQuoteImpactPreview,
} from "../dtf-margin-preview";

const LANES = ["T1", "T2", "T3", "T4"] as const;

describe("DTF margin preview calculation engine", () => {
  it("reproduces all 23 tiers x 4 lanes from the captured contract", () => {
    const preview = calculateDtfMarginPreview({ edits: [] });

    expect(preview.schemaVersion).toBe(contract.schemaVersion);
    expect(preview.tiers).toHaveLength(23);

    for (const tier of contract.dtfEngine.tierPriceMatrix) {
      const calculated = preview.tiers.find((row) => row.tier === tier.tier);
      expect(calculated).toBeDefined();

      for (const lane of LANES) {
        expect(calculated!.lanes[lane].draft.final).toBe(tier.prices[lane].toFixed(2));
      }
    }
  });

  it("includes the required trace for the 72-143 T4 baseline example", () => {
    const preview = calculateDtfMarginPreview({ edits: [] });
    const row = preview.tiers.find((tier) => tier.tier === "72-143");

    expect(row).toMatchObject({
      baseDtfCogs: expect.any(String),
      laborRecovery: expect.any(String),
    });
    expect(row?.lanes.T1.draft.final).toBe("6.55");
    expect(row?.lanes.T2.draft.final).toBe("6.00");
    expect(row?.lanes.T3.draft.final).toBe("5.55");
    expect(row?.lanes.T4.draft).toMatchObject({
      baseDtfCogs: expect.any(String),
      laborRecovery: expect.any(String),
      targetMargin: "0.35",
      marginLoadedAmount: expect.any(String),
      raw: expect.any(String),
      increment: "0.05",
      final: "5.15",
      achievedMargin: expect.any(String),
    });
  });

  it("changes only the edited sparse tier/lane cell", () => {
    const baseline = calculateDtfMarginPreview({ edits: [] });
    const draft = calculateDtfMarginPreview({
      edits: [{ tier: "72-143", lane: "T4", marginPercent: 50 }],
    });

    for (const tier of baseline.tiers) {
      for (const lane of LANES) {
        const expectedChangedCell = tier.tier === "72-143" && lane === "T4";
        const actual = draft.tiers.find((row) => row.tier === tier.tier)!.lanes[lane];

        if (expectedChangedCell) {
          expect(actual.draft.final).not.toBe(tier.lanes[lane].draft.final);
          expect(actual.edited).toBe(true);
        } else {
          expect(actual.draft.final).toBe(tier.lanes[lane].draft.final);
          expect(actual.edited).toBe(false);
        }
      }
    }
  });

  it("accepts user percentage form and rejects invalid edits", () => {
    expect(
      DraftMarginInputSchema.parse({
        edits: [{ tier: "72-143", lane: "T4", marginPercent: 35 }],
      }).edits[0].margin
    ).toBe("0.35");

    for (const invalid of [
      { edits: [{ tier: "missing", lane: "T4", marginPercent: 35 }] },
      { edits: [{ tier: "72-143", lane: "T5", marginPercent: 35 }] },
      { edits: [{ tier: "72-143", lane: "T4", marginPercent: -1 }] },
      { edits: [{ tier: "72-143", lane: "T4", marginPercent: 100 }] },
      { edits: [{ tier: "72-143", lane: "T4", marginPercent: Number.NaN }] },
      {
        edits: [
          { tier: "72-143", lane: "T4", marginPercent: 35 },
          { tier: "72-143", lane: "T4", marginPercent: 40 },
        ],
      },
    ]) {
      expect(DraftMarginInputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("calculates quote impact without changing contract multipliers or commission", () => {
    const preview = calculateQuoteImpactPreview({
      productCost: 4.8,
      quantity: 174,
      lane: "T1",
      edits: [{ tier: "144-249", lane: "T1", marginPercent: 50 }],
    });

    expect(preview.current).toMatchObject({
      productSell: "9.60",
      decorationSell: "6.00",
      unitPrice: "15.60",
      orderTotal: "2714.40",
    });
    expect(preview.current.commissionReserve).toBe("1.25");
    expect(preview.draft.productSell).toBe("9.60");
    expect(preview.draft.commissionReserve).toBe(preview.current.commissionReserve);
  });

  it("adds modeled quote contribution using active tier decoration COGS", () => {
    const preview = calculateQuoteImpactPreview({
      productCost: 4.8,
      quantity: 174,
      lane: "T1",
      edits: [{ tier: "144-249", lane: "T1", marginPercent: 55 }],
    });

    expect(preview.contributionBasis).toContain("active tier COGS");
    expect(preview.current).toMatchObject({
      modeledDecorationCogs: "3.11",
      totalProductionCogs: "7.91",
      grossProfitBeforeCommission: "7.69",
      netContributionAfterCommission: "6.44",
      contributionMarginAfterCommission: "0.413127351",
      netContributionOrderTotal: "1121.39",
    });
    expect(preview.draft).toMatchObject({
      decorationSell: "6.60",
      modeledDecorationCogs: preview.current.modeledDecorationCogs,
      grossProfitBeforeCommission: "8.29",
      netContributionAfterCommission: "7.00",
      contributionMarginAfterCommission: "0.4319004121",
      netContributionOrderTotal: "1217.44",
    });
    expect(preview.delta).toMatchObject({
      grossProfitBeforeCommission: "0.60",
      netContributionAfterCommission: "0.56",
      contributionMarginAfterCommission: "0.0187730611",
      netContributionOrderTotal: "96.05",
    });
  });
});
