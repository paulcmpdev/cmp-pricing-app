import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateQuantity } from "@/lib/pricing/quantity";
import {
  quoteFlatFeeFromConfigStaff,
  quoteFlatFeeFromConfigManager,
} from "@/lib/server/quote-service";
import {
  requireRole,
  resolveAuthenticatedProjection,
} from "@/lib/server/auth/route-guards";
import { resolveActiveConfig } from "@/lib/server/pricing-config/resolver";
import type { AdditionalPrintsConfig } from "@/lib/server/pricing-config/schemas";

const FlatFeeRequestSchema = z
  .object({
    service: z.string().min(1).max(60),
    orderQuantity: z.number().int().min(1),
    // Manager-only session controls are applied only after server-side role resolution.
    extraOperatorMinutesPerShirt: z.number().finite().min(0).max(480).default(0),
    extraDesignerMinutesPerOrder: z.number().finite().min(0).max(1_440).default(0),
    manualOverride: z.number().finite().min(0).max(100_000).nullable().default(null),
  })
  .strict();

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

  const parsed = FlatFeeRequestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  // Resolve active Additional Prints config
  const configResult = await resolveActiveConfig("additional_prints");
  if (!configResult.ok) {
    return NextResponse.json(
      { error: { _form: [configResult.error] } },
      { status: 503 }
    );
  }

  const apConfig: AdditionalPrintsConfig =
    configResult.source === "database"
      ? (configResult.version.data as AdditionalPrintsConfig)
      : (configResult.data as AdditionalPrintsConfig);

  // Validate service key against active services in config
  const activeServices = apConfig.services.filter((s) => s.active);
  const serviceConfig = activeServices.find((s) => s.key === parsed.data.service);
  if (!serviceConfig) {
    const availableKeys = activeServices.map((s) => s.key);
    return NextResponse.json(
      {
        error: {
          service: [
            `Unknown service "${parsed.data.service}". Available: ${availableKeys.join(", ")}`,
          ],
        },
      },
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

  // Resolve projection level
  const projection = await resolveAuthenticatedProjection(request);
  const isManager = projection === "manager";

  const input = {
    serviceKey: parsed.data.service,
    orderQuantity: parsed.data.orderQuantity,
    minimumBillableQuantity: apConfig.minimumBillableQuantity,
    // Staff cannot apply manager session controls, regardless of request body.
    extraOperatorMinutesPerShirt: isManager
      ? parsed.data.extraOperatorMinutesPerShirt
      : 0,
    extraDesignerMinutesPerOrder: isManager
      ? parsed.data.extraDesignerMinutesPerOrder
      : 0,
    manualOverride: isManager ? parsed.data.manualOverride : null,
  };

  try {
    const result = isManager
      ? quoteFlatFeeFromConfigManager(serviceConfig, input)
      : quoteFlatFeeFromConfigStaff(serviceConfig, input);

    return NextResponse.json({
      ...result,
      requiresManagerReview: qtyValidation.requiresManagerReview,
    });
  } catch (e) {
    return NextResponse.json(
      { error: { _engine: [(e as Error).message] } },
      { status: 422 }
    );
  }
}
