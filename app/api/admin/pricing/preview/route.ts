import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  PreviewPostBodySchema,
  calculateDtfMarginPreview,
  calculateQuoteImpactPreview,
} from "@/lib/pricing/dtf-margin-preview";
import { isPricingPreviewEnabled } from "@/lib/server/pricing-preview-gate";

const MAX_BODY_BYTES = 16_384;

function disabledResponse() {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

function validationResponse(error: z.ZodError) {
  const flattened = error.flatten();
  return NextResponse.json(
    {
      error: {
        ...flattened.fieldErrors,
        ...(flattened.formErrors.length > 0
          ? { _form: flattened.formErrors }
          : {}),
      },
    },
    { status: 400 }
  );
}

export async function GET() {
  if (!isPricingPreviewEnabled()) {
    return disabledResponse();
  }

  return NextResponse.json(calculateDtfMarginPreview({ edits: [] }));
}

export async function POST(request: NextRequest) {
  if (!isPricingPreviewEnabled()) {
    return disabledResponse();
  }

  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: { _form: ["Request body is too large."] } },
      { status: 413 }
    );
  }

  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json(
      { error: { _form: ["Malformed JSON in request body."] } },
      { status: 400 }
    );
  }

  const parsed = PreviewPostBodySchema.safeParse(body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  const preview = calculateDtfMarginPreview({ edits: parsed.data.edits });
  const quote = parsed.data.quote
    ? calculateQuoteImpactPreview({ ...parsed.data.quote, edits: parsed.data.edits })
    : undefined;

  return NextResponse.json({
    preview,
    ...(quote ? { quote } : {}),
  });
}
