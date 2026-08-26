import { NextRequest, NextResponse } from "next/server";

const MAX_MUTATION_BODY_BYTES = 16_384;

type MutationBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; response: NextResponse };

/**
 * Custom Admin mutation routes do not inherit NextAuth's CSRF checks.
 * Require a same-origin browser request and stream-count the JSON body so
 * HTTP/2 or chunked requests cannot bypass the size bound by omitting
 * Content-Length.
 */
export async function readSameOriginJsonMutation(
  request: NextRequest
): Promise<MutationBodyResult> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Content-Type must be application/json." },
        { status: 415 }
      ),
    };
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const size = Number(declaredLength);
    if (!Number.isInteger(size) || size < 0 || size > MAX_MUTATION_BODY_BYTES) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Request body is too large." },
          { status: 413 }
        ),
      };
    }
  }

  const origin = request.headers.get("origin");
  if (!origin) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Origin is required." }, { status: 403 }),
    };
  }

  try {
    if (new URL(origin).origin !== new URL(request.url).origin) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Cross-origin mutation denied." },
          { status: 403 }
        ),
      };
    }
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid Origin." }, { status: 403 }),
    };
  }

  if (!request.body) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid JSON." }, { status: 400 }),
    };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_MUTATION_BODY_BYTES) {
        await reader.cancel();
        return {
          ok: false,
          response: NextResponse.json(
            { error: "Request body is too large." },
            { status: 413 }
          ),
        };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid request body." }, { status: 400 }),
    };
  }

  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid JSON." }, { status: 400 }),
    };
  }
}
