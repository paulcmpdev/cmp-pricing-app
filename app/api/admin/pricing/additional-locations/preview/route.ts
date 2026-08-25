import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  calculateAdditionalLocationMatrixPreview,
  ADDITIONAL_LOCATION_MARGIN_LANES,
} from "@/lib/pricing/additional-location-matrix-preview";
import { isAdditionalLocationsPreviewEnabled } from "@/lib/server/pricing-preview-gate";

const MarginEditsSchema = z.object({
  edits: z.record(
    z.enum(ADDITIONAL_LOCATION_MARGIN_LANES as unknown as [string, ...string[]]),
    z
      .number()
      .finite()
      .min(0)
      .lt(100)
      .refine((value) => value === 0 || value >= 1, {
        message: "Use percentage points, e.g. 58 for 58%.",
      })
  ).default({}),
}).strict();

function disabledResponse() {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

export async function GET() {
  if (!isAdditionalLocationsPreviewEnabled()) {
    return disabledResponse();
  }

  return NextResponse.json(
    calculateAdditionalLocationMatrixPreview({ edits: {} })
  );
}

export async function POST(request: NextRequest) {
  if (!isAdditionalLocationsPreviewEnabled()) {
    return disabledResponse();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { _form: ["Malformed JSON in request body."] } },
      { status: 400 }
    );
  }

  const parsed = MarginEditsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  return NextResponse.json(
    calculateAdditionalLocationMatrixPreview({ edits: parsed.data.edits })
  );
}
