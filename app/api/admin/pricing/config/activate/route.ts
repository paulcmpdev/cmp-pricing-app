import { NextRequest, NextResponse } from "next/server";
import { requireRole, getAuthSession } from "@/lib/server/auth/route-guards";
import { isAuthEnabled } from "@/lib/server/auth/policy";
import { isPricingConfigEnabled } from "@/lib/server/pricing-config/gate";
import { readSameOriginJsonMutation } from "@/lib/server/auth/mutation-request";
import { ActivatePricingConfigRequestSchema } from "@/lib/server/pricing-config/schemas";

/**
 * POST /api/admin/pricing/config/activate
 *
 * Activates a prior version (rollback). Creates a new immutable copy.
 * Requires auth enabled, admin role, and CMP_PRICING_CONFIG_ENABLED=true.
 */
export async function POST(request: NextRequest) {
  // Fail closed: persistence requires auth
  if (!isAuthEnabled()) {
    return NextResponse.json(
      { error: "Authentication must be enabled for pricing config writes." },
      { status: 403 }
    );
  }

  const authError = await requireRole(request, "admin_access");
  if (authError) return authError;

  if (!isPricingConfigEnabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // Same-origin, content-type, and stream-counted body-size guard
  const bodyResult = await readSameOriginJsonMutation(request);
  if (!bodyResult.ok) return bodyResult.response;

  const parsed = ActivatePricingConfigRequestSchema.safeParse(bodyResult.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Reject if authenticated actor email is absent
  const session = await getAuthSession(request);
  if (!session?.email) {
    return NextResponse.json(
      { error: "Authenticated actor email is required." },
      { status: 403 }
    );
  }
  const actorEmail = session.email;

  try {
    const { getPricingConfigRepository, isPricingConfigDatabaseConfigured } =
      await import("@/lib/server/pricing-config/repository");

    if (!isPricingConfigDatabaseConfigured()) {
      return NextResponse.json(
        { error: "Pricing config database is not configured." },
        { status: 503 }
      );
    }

    const repo = getPricingConfigRepository();
    const result = await repo.activateVersion(
      parsed.data.configType,
      parsed.data.versionId,
      parsed.data.expectedCurrentVersionId,
      actorEmail
    );

    if (!result.ok) {
      const status =
        result.reason === "not_found"
          ? 404
          : result.reason === "invalid_snapshot"
            ? 422
            : 409;
      return NextResponse.json({ error: result.message }, { status });
    }

    return NextResponse.json({
      ok: true,
      version: {
        id: result.version.id,
        status: result.version.status,
        createdBy: result.version.createdBy,
        createdAt: result.version.createdAt,
        activatedAt: result.version.activatedAt,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Pricing configuration database is unavailable." },
      { status: 503 }
    );
  }
}
