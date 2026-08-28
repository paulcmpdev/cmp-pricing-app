import { NextRequest, NextResponse } from "next/server";
import { requireRole, getAuthSession } from "@/lib/server/auth/route-guards";
import { isAuthEnabled } from "@/lib/server/auth/policy";
import { isPricingConfigEditorEnabled } from "@/lib/server/pricing-preview-gate";
import { isPricingConfigEnabled } from "@/lib/server/pricing-config/gate";
import { resolveActiveConfig } from "@/lib/server/pricing-config/resolver";
import { getBaselineDtfMatrix, getBaselineAdditionalPrints } from "@/lib/server/pricing-config/baseline";
import { readSameOriginJsonMutation } from "@/lib/server/auth/mutation-request";
import {
  SavePricingConfigRequestSchema,
  CONFIG_TYPES,
  type ConfigType,
} from "@/lib/server/pricing-config/schemas";

// 1 MiB. The schema's own bounds (max string lengths, max array sizes) fix a
// finite worst case, but that worst case must be computed in *serialized
// bytes*, not JS string length: `.max(n)` on a Zod string caps `.length`
// (UTF-16 code units), and each code unit can appear on the wire as a
// `\uXXXX` JSON escape — 6 ASCII bytes per unit, the maximum possible
// expansion for any single code unit (plain UTF-8 multibyte characters are
// cheaper, at 2-4 bytes). Serializing the largest schema-valid Additional
// Prints payload (50 services, 30 columns, 20 composition rows/service, every
// bounded string maxed out and escape-expanded) comes to ~632 KiB; the
// largest DTF matrix payload (20 lanes, 50 tiers) comes to ~138 KiB. 1 MiB
// keeps ~400 KiB of headroom over the larger of the two while still being a
// firm, finite cap — see config-route.test.ts for the payloads this is
// checked against.
export const MAX_PRICING_CONFIG_BODY_BYTES = 1_048_576;

function notEnabledResponse() {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

/**
 * GET /api/admin/pricing/config?type=dtf_matrix|additional_prints
 *
 * Returns the active config for the given type.
 */
export async function GET(request: NextRequest) {
  if (isPricingConfigEnabled()) {
    // Fail closed: this branch can surface database-sourced config, COGS,
    // manual overrides, and version metadata. requireRole() passes every
    // request through when auth is disabled, so that alone is not sufficient
    // to keep persisted data private — reject explicitly instead.
    if (!isAuthEnabled()) {
      return NextResponse.json(
        { error: "Authentication must be enabled to view pricing config." },
        { status: 403 }
      );
    }

    const authError = await requireRole(request, "admin_access");
    if (authError) return authError;
  } else {
    // Preview-only baseline: no persisted/sensitive data is at risk, so this
    // follows the same access pattern as the other Preview-only routes —
    // requireRole() is a no-op pass-through when auth is disabled (the local/
    // preview baseline case) but still enforces admin access when auth is on.
    const authError = await requireRole(request, "admin_access");
    if (authError) return authError;

    if (!isPricingConfigEditorEnabled()) {
      return notEnabledResponse();
    }
  }

  const configType = request.nextUrl.searchParams.get("type") as ConfigType | null;
  if (!configType || !CONFIG_TYPES.includes(configType as ConfigType)) {
    return NextResponse.json(
      { error: "Query parameter 'type' must be 'dtf_matrix' or 'additional_prints'." },
      { status: 400 }
    );
  }

  const result = await resolveActiveConfig(configType);
  if (!result.ok) {
    // A fresh/migrated database with no active version yet is an admin-recoverable
    // state, not an outage: serve baseline defaults so the editor can be used to
    // create and activate the first version. All other failure reasons (database
    // unavailable, not configured, stored data failed validation) stay fail-closed.
    if (result.reason === "no_active_version") {
      const baselineData =
        configType === "dtf_matrix" ? getBaselineDtfMatrix() : getBaselineAdditionalPrints();
      return NextResponse.json({
        source: "baseline",
        persistenceEnabled: true,
        bootstrapRequired: true,
        version: null,
        data: baselineData,
      });
    }
    return NextResponse.json({ error: result.error }, { status: 503 });
  }

  if (result.source === "baseline") {
    return NextResponse.json({
      source: "baseline",
      persistenceEnabled: isPricingConfigEnabled(),
      version: null,
      data: result.data,
    });
  }

  return NextResponse.json({
    source: "database",
    persistenceEnabled: true,
    version: {
      id: result.version.id,
      status: result.version.status,
      createdBy: result.version.createdBy,
      createdAt: result.version.createdAt,
      activatedAt: result.version.activatedAt,
    },
    data: result.version.data,
  });
}

/**
 * PUT /api/admin/pricing/config
 *
 * Saves and activates a new pricing config version.
 * Requires auth enabled, admin role, and CMP_PRICING_CONFIG_ENABLED=true.
 * Fail-closed: rejects if auth is disabled while persistence is enabled.
 */
export async function PUT(request: NextRequest) {
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
    return notEnabledResponse();
  }

  // Same-origin, content-type, and stream-counted body-size guard. Pricing
  // config payloads (up to 50 services / 30 columns / 50 tiers / 20 lanes)
  // are larger than typical admin mutations, so this route uses its own
  // explicit cap rather than the shared default.
  const bodyResult = await readSameOriginJsonMutation(request, MAX_PRICING_CONFIG_BODY_BYTES);
  if (!bodyResult.ok) return bodyResult.response;

  const parsed = SavePricingConfigRequestSchema.safeParse(bodyResult.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Get actor email — reject if absent
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
    const result = await repo.saveAndActivate(
      parsed.data.configType,
      parsed.data.data,
      actorEmail,
      parsed.data.expectedVersion
    );

    if (!result.ok) {
      return NextResponse.json(
        { error: result.message },
        { status: 409 }
      );
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
