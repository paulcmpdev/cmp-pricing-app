import "server-only";
import { d, roundUpToIncrement } from "./money";
import fixture from "@/lib/fixtures/additional-location-matrix.json";

export const ADDITIONAL_LOCATION_MARGIN_LANES = ["T1", "T2", "T3", "T4"] as const;
export type AdditionalLocationMarginLane = (typeof ADDITIONAL_LOCATION_MARGIN_LANES)[number];

const ROUNDING_INCREMENT = 0.05;

type MarginEdits = Partial<Record<AdditionalLocationMarginLane, number>>;

export type AdditionalLocationMatrixRow = {
  printKey: string;
  location: string;
  widthIn: number;
  heightIn: number;
  tier: string;
  minQty: number;
  maxQty: number;
  cogsPerPiece: number;
  prices: Record<AdditionalLocationMarginLane, {
    current: number;
    draft: number;
    delta: number;
  }>;
};

export type AdditionalLocationMatrixPreview = {
  marginLanes: Record<AdditionalLocationMarginLane, number>;
  draftMargins: Record<AdditionalLocationMarginLane, number>;
  isDirty: boolean;
  rows: AdditionalLocationMatrixRow[];
};

function calculatePrice(cogsPerPiece: number, margin: number): number {
  const oneMinusMargin = d(1).minus(d(margin));
  const raw = d(cogsPerPiece).div(oneMinusMargin);
  return roundUpToIncrement(raw, ROUNDING_INCREMENT).toNumber();
}

export function calculateAdditionalLocationMatrixPreview(
  input: { edits: MarginEdits }
): AdditionalLocationMatrixPreview {
  const currentMargins = fixture.marginLanes as Record<AdditionalLocationMarginLane, number>;

  const draftMargins = {} as Record<AdditionalLocationMarginLane, number>;
  let isDirty = false;

  for (const lane of ADDITIONAL_LOCATION_MARGIN_LANES) {
    if (lane in input.edits) {
      draftMargins[lane] = d(input.edits[lane]!).div(100).toNumber();
      if (draftMargins[lane] !== currentMargins[lane]) {
        isDirty = true;
      }
    } else {
      draftMargins[lane] = currentMargins[lane];
    }
  }

  const rows: AdditionalLocationMatrixRow[] = fixture.rows.map((row) => {
    const prices = {} as Record<AdditionalLocationMarginLane, {
      current: number;
      draft: number;
      delta: number;
    }>;

    for (const lane of ADDITIONAL_LOCATION_MARGIN_LANES) {
      const current = calculatePrice(row.cogsPerPiece, currentMargins[lane]);
      const draft = calculatePrice(row.cogsPerPiece, draftMargins[lane]);
      prices[lane] = {
        current,
        draft,
        delta: d(draft).minus(current).toNumber(),
      };
    }

    return {
      printKey: row.printKey,
      location: row.location,
      widthIn: row.widthIn,
      heightIn: row.heightIn,
      tier: row.tier,
      minQty: row.minQty,
      maxQty: row.maxQty,
      cogsPerPiece: row.cogsPerPiece,
      prices,
    };
  });

  return {
    marginLanes: currentMargins,
    draftMargins,
    isDirty,
    rows,
  };
}
