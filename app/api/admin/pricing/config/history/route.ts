import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/server/auth/route-guards";
import { isAuthEnabled } from "@/lib/server/auth/policy";
import { isPricingConfigEnabled } from "@/lib/server/pricing-config/gate";
import { CONFIG_TYPES, type ConfigType } from "@/lib/server/pricing-config/schemas";

/**
 * GET /api/admin/pricing/config/history?type=dtf_matrix|additional_prints
 *
 * Returns recent version history (metadata only, no snapshot data) for the
 * given config type so an admin can choose a rollback target.
 */
export async function GET(request: NextRequest) {
  // History only ever exists for persisted config. In Preview-only mode
  // (persistence disabled) it stays unavailable regardless of auth state —
  // the UI never calls this route in that mode either.
  if (!isPricingConfigEnabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // Fail closed: history exposes actor emails and version metadata.
  // requireRole() passes every request through when auth is disabled, so
  // that alone is not sufficient — reject explicitly instead.
  if (!isAuthEnabled()) {
    return NextResponse.json(
      { error: "Authentication must be enabled to view pricing config history." },
      { status: 403 }
    );
  }

  const authError = await requireRole(request, "admin_access");
  if (authError) return authError;

  const configType = request.nextUrl.searchParams.get("type") as ConfigType | null;
  if (!configType || !CONFIG_TYPES.includes(configType as ConfigType)) {
    return NextResponse.json(
      { error: "Query parameter 'type' must be 'dtf_matrix' or 'additional_prints'." },
      { status: 400 }
    );
  }

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
    const versions = await repo.listVersions(configType, 20);

    return NextResponse.json({
      versions: versions.map((v) => ({
        id: v.id,
        status: v.status,
        createdBy: v.createdBy,
        createdAt: v.createdAt,
        activatedAt: v.activatedAt,
        supersededAt: v.supersededAt,
      })),
    });
  } catch {
    return NextResponse.json(
      { error: "Pricing configuration database is unavailable." },
      { status: 503 }
    );
  }
}
