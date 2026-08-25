import { describe, it, expect } from "vitest";
import {
  calculateAdditionalLocationMatrixPreview,
  ADDITIONAL_LOCATION_MARGIN_LANES,
  type AdditionalLocationMarginLane,
} from "../additional-location-matrix-preview";
import fixture from "@/lib/fixtures/additional-location-matrix.json";

const LANES = ADDITIONAL_LOCATION_MARGIN_LANES;
const CURRENT_MARGINS = fixture.marginLanes;

describe("additional location matrix preview", () => {
  const preview = calculateAdditionalLocationMatrixPreview({ edits: {} });

  it("returns all 104 fixture rows", () => {
    expect(preview.rows).toHaveLength(104);
  });

  it("has 13 unique print keys", () => {
    const keys = new Set(preview.rows.map((r) => r.printKey));
    expect(keys.size).toBe(13);
  });

  it("has 8 tiers per print key", () => {
    const groups = new Map<string, number>();
    for (const row of preview.rows) {
      groups.set(row.printKey, (groups.get(row.printKey) ?? 0) + 1);
    }
    groups.forEach((count, key) => {
      expect(count, `${key} should have 8 tiers`).toBe(8);
    });
  });

  it("returns current margin lanes", () => {
    expect(preview.marginLanes).toEqual(CURRENT_MARGINS);
  });
});

describe("workbook parity for all 416 current prices", () => {
  const preview = calculateAdditionalLocationMatrixPreview({ edits: {} });

  for (const fixtureRow of fixture.rows) {
    for (const lane of LANES) {
      const expectedPrice = fixtureRow.prices[lane];
      const label = `${fixtureRow.printKey} ${fixtureRow.tier} ${lane}`;

      it(`${label} = $${expectedPrice}`, () => {
        const previewRow = preview.rows.find(
          (r) => r.printKey === fixtureRow.printKey && r.tier === fixtureRow.tier
        );
        expect(previewRow, `row not found: ${label}`).toBeDefined();
        expect(previewRow!.prices[lane].current).toBeCloseTo(expectedPrice, 10);
      });
    }
  }
});

describe("margin edits recalculate draft prices", () => {
  const preview = calculateAdditionalLocationMatrixPreview({
    edits: { T1: 60 },
  });

  it("draft margin for T1 is 60%", () => {
    expect(preview.draftMargins.T1).toBe(0.6);
  });

  it("unedited lanes keep current margins", () => {
    expect(preview.draftMargins.T2).toBe(CURRENT_MARGINS.T2);
    expect(preview.draftMargins.T3).toBe(CURRENT_MARGINS.T3);
    expect(preview.draftMargins.T4).toBe(CURRENT_MARGINS.T4);
  });

  it("draft T1 prices differ from current for at least one row", () => {
    const changed = preview.rows.some(
      (r) => r.prices.T1.draft !== r.prices.T1.current
    );
    expect(changed).toBe(true);
  });

  it("draft prices use upward $0.05 rounding", () => {
    for (const row of preview.rows) {
      for (const lane of LANES) {
        const draft = row.prices[lane].draft;
        const remainder = Math.round(draft * 100) % 5;
        expect(remainder, `${row.printKey} ${row.tier} ${lane} draft=$${draft}`).toBe(0);
      }
    }
  });

  it("draft T1 price = ceil(COGS / (1 - 0.60), $0.05) for STRAIGHT 12-23", () => {
    const row = preview.rows.find(
      (r) => r.printKey === "STRAIGHT" && r.tier === "12-23"
    )!;
    // COGS = 3.526643737672584, margin = 0.60
    // Raw = 3.526643737672584 / 0.40 = 8.81661...
    // Ceil to $0.05 = $8.85
    expect(row.prices.T1.draft).toBeCloseTo(8.85, 10);
  });
});

describe("delta calculation", () => {
  const preview = calculateAdditionalLocationMatrixPreview({
    edits: { T1: 60 },
  });

  it("delta = draft - current", () => {
    const row = preview.rows.find(
      (r) => r.printKey === "STRAIGHT" && r.tier === "12-23"
    )!;
    const expected = row.prices.T1.draft - row.prices.T1.current;
    expect(row.prices.T1.delta).toBeCloseTo(expected, 10);
  });

  it("unedited lanes have zero delta", () => {
    for (const row of preview.rows) {
      expect(row.prices.T2.delta).toBe(0);
      expect(row.prices.T3.delta).toBe(0);
      expect(row.prices.T4.delta).toBe(0);
    }
  });
});

describe("isDirty tracking", () => {
  it("is not dirty with no edits", () => {
    const preview = calculateAdditionalLocationMatrixPreview({ edits: {} });
    expect(preview.isDirty).toBe(false);
  });

  it("is dirty with any margin edit", () => {
    const preview = calculateAdditionalLocationMatrixPreview({
      edits: { T3: 46 },
    });
    expect(preview.isDirty).toBe(true);
  });
});
