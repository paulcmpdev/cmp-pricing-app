import { NextRequest, NextResponse } from "next/server";
import { FlatFeeInputSchema } from "@/lib/pricing/schemas";
import { quoteFlatFeeStaff, quoteFlatFeeManager } from "@/lib/server/quote-service";
import { validateQuantity } from "@/lib/pricing/quantity";
import contract from "@/lib/fixtures/pricing-contract.json";
import {
  requireRole,
  resolveAuthenticatedProjection,
} from "@/lib/server/auth/route-guards";

const VALID_SERVICES = new Set(
  contract.flatFeeServices.map((s) => s.service)
);

export async function POST(request: NextRequest) {
  const authError = await requireRole(request, "view_quotes");
  if (authError) return authError;

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

  // Resolve projection level: auth-aware when CMP_AUTH_ENABLED=true,
  // otherwise falls back to legacy preview/local-manager behavior.
  const projection = await resolveAuthenticatedProjection(request);
  const isManager = projection === "manager";

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
