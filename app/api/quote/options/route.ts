import { NextRequest, NextResponse } from "next/server";
import {
  requireRole,
  resolveAuthenticatedProjection,
} from "@/lib/server/auth/route-guards";
import { resolveActiveConfig } from "@/lib/server/pricing-config/resolver";
import type {
  DtfMatrixConfig,
  AdditionalPrintsConfig,
} from "@/lib/server/pricing-config/schemas";

/**
 * GET /api/quote/options
 *
 * Returns staff-safe selector options derived from the active pricing config.
 * No COGS, margins, or internal engine fields are exposed.
 */
export async function GET(request: NextRequest) {
  const authError = await requireRole(request, "view_quotes");
  if (authError) return authError;

  const projection = await resolveAuthenticatedProjection(request);

  const dtfResult = await resolveActiveConfig("dtf_matrix");
  if (!dtfResult.ok) {
    return NextResponse.json({ error: dtfResult.error }, { status: 503 });
  }

  const apResult = await resolveActiveConfig("additional_prints");
  if (!apResult.ok) {
    return NextResponse.json({ error: apResult.error }, { status: 503 });
  }

  const dtfConfig: DtfMatrixConfig =
    dtfResult.source === "database"
      ? (dtfResult.version.data as DtfMatrixConfig)
      : (dtfResult.data as DtfMatrixConfig);

  const apConfig: AdditionalPrintsConfig =
    apResult.source === "database"
      ? (apResult.version.data as AdditionalPrintsConfig)
      : (apResult.data as AdditionalPrintsConfig);

  return NextResponse.json({
    canOverridePricingLane: projection === "manager",
    lanes: dtfConfig.lanes
      .filter((l) => l.active)
      .map((l) => ({ key: l.key, label: l.label })),
    services: apConfig.services
      .filter((s) => s.active)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((s) => ({
        key: s.key,
        name: s.name,
        description: s.description,
        type: s.type,
        effectivePrice: s.effectivePrice,
      })),
    minimumBillableQuantity: apConfig.minimumBillableQuantity,
  });
}
