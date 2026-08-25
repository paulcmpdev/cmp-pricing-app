import { NextRequest, NextResponse } from "next/server";
import { FlatFeeInputSchema } from "@/lib/pricing/schemas";
import { quoteFlatFeeStaff, quoteFlatFeeManager } from "@/lib/server/quote-service";
import { validateQuantity } from "@/lib/pricing/quantity";
import contract from "@/lib/fixtures/pricing-contract.json";
import { isAdditionalLocationsPreviewEnabled } from "@/lib/server/pricing-preview-gate";

const VALID_SERVICES = new Set(
  contract.flatFeeServices.map((s) => s.service)
);

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { _form: ["Malformed JSON in request body."] } },
      { status: 400 }
    );
  }

  const parsed = FlatFeeInputSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  // Validate service name against known services
  if (!VALID_SERVICES.has(parsed.data.service)) {
    return NextResponse.json(
      { error: { service: [`Unknown flat-fee service: ${parsed.data.service}`] } },
      { status: 422 }
    );
  }

  // Validate quantity
  const qtyValidation = validateQuantity(parsed.data.orderQuantity);
  if (!qtyValidation.valid) {
    return NextResponse.json(
      { error: { orderQuantity: [qtyValidation.error!] } },
      { status: 422 }
    );
  }

  // Manager mode exposes raw cost data. Allow it under:
  // 1. Additional-locations preview: server-enforced via env gate. Access to
  //    preview deployments is protected by Vercel Deployment Protection;
  //    VERCEL_ENV=production hard blocks even when the flag is set.
  //    A spoofed x-cmp-role header alone never unlocks preview COGS.
  // 2. Local manager opt-in (non-production + explicit env var + header)
  const role = request.headers.get("x-cmp-role");
  const localManagerAllowed =
    role === "manager" &&
    process.env.NODE_ENV !== "production" &&
    process.env.CMP_ALLOW_LOCAL_MANAGER_MODE === "true";
  const previewManagerAllowed = isAdditionalLocationsPreviewEnabled();
  const isManager = previewManagerAllowed || localManagerAllowed;

  let result;
  try {
    result = isManager
      ? quoteFlatFeeManager(parsed.data)
      : quoteFlatFeeStaff(parsed.data);
  } catch (e) {
    return NextResponse.json(
      { error: { _engine: [(e as Error).message] } },
      { status: 422 }
    );
  }

  return NextResponse.json({
    ...result,
    requiresManagerReview: qtyValidation.requiresManagerReview,
  });
}
