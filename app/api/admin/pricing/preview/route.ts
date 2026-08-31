import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  DtfMatrixPreviewBodySchema,
  calculateMatrixPreview,
  calculateQuoteImpact,
} from "@/lib/pricing/dtf-matrix-preview";
import { getBaselineDtfMatrix } from "@/lib/server/pricing-config/baseline";
import { isPricingPreviewEnabled } from "@/lib/server/pricing-preview-gate";
import { requireRole } from "@/lib/server/auth/route-guards";

// A preview body carries up to two full matrix drafts (saved + unsaved).
// Both are size-bounded by DtfMatrixDraftSchema (<=50 tiers x <=20 lanes),
// so this cap only needs to be generous enough for the largest legal pair.
const MAX_BODY_BYTES = 65_536;

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

export async function GET(request: NextRequest) {
  const authError = await requireRole(request, "admin_access");
  if (authError) return authError;

  if (!isPricingPreviewEnabled()) {
    return disabledResponse();
  }

  // Read-only context for the unified editor: the verified baseline matrix.
  return NextResponse.json(calculateMatrixPreview(getBaselineDtfMatrix()));
}

export async function POST(request: NextRequest) {
  const authError = await requireRole(request, "admin_access");
  if (authError) return authError;

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

  const parsed = DtfMatrixPreviewBodySchema.safeParse(body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  const { draft, current, quote } = parsed.data;
  const preview = calculateMatrixPreview(draft);
  const quoteImpact = quote
    ? calculateQuoteImpact({ draft, current, quote })
    : undefined;

  return NextResponse.json({
    preview,
    ...(quoteImpact ? { quote: quoteImpact } : {}),
  });
}
