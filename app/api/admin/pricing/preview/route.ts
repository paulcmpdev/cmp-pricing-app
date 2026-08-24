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

function bodyTooLargeResponse() {
  return NextResponse.json(
    { error: { _form: ["Request body is too large."] } },
    { status: 413 }
  );
}

function declaredContentLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (value == null || value.trim() === "") {
    return null;
  }

  if (!/^\d+$/.test(value.trim())) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

async function readBodyWithCap(request: NextRequest, maxBytes: number) {
  const declaredLength = declaredContentLength(request.headers);
  if (declaredLength != null && declaredLength > maxBytes) {
    return { tooLarge: true as const };
  }

  if (!request.body) {
    return { tooLarge: false as const, text: "" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return { tooLarge: true as const };
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    tooLarge: false as const,
    text: new TextDecoder("utf-8", { fatal: false }).decode(
      chunks.length === 1 ? chunks[0] : concatChunks(chunks, totalBytes)
    ),
  };
}

function concatChunks(chunks: Uint8Array[], totalBytes: number) {
  const body = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
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

  const bodyRead = await readBodyWithCap(request, MAX_BODY_BYTES);
  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse();
  }

  let body: unknown;
  try {
    body = bodyRead.text.length > 0 ? JSON.parse(bodyRead.text) : {};
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
