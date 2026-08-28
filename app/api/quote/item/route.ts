import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ItemPriceInputSchema } from "@/lib/pricing/schemas";
import { quoteItemStaff, quoteItemManager } from "@/lib/server/quote-service";
import { resolveProductCost } from "@/lib/server/catalog";
import {
  getVendorCatalogStatus,
  resolveCatalogVariantCost,
  type CatalogVariantCostResolution,
} from "@/lib/server/vendor-catalog/repository";
import { validateQuantity } from "@/lib/pricing/quantity";
import {
  requireRole,
  resolveAuthenticatedProjection,
} from "@/lib/server/auth/route-guards";
import { resolveActiveConfig } from "@/lib/server/pricing-config/resolver";
import type { DtfMatrixConfig } from "@/lib/server/pricing-config/schemas";

/**
 * Accepts either { productCost } directly or { sku } to resolve cost server-side.
 * The client never needs to know product costs.
 * Lane is validated dynamically against active config.
 */
const RequestBodySchema = z
  .object({
    sku: z.string().optional(),
    catalogVariantId: z.string().optional(),
    productCost: z.number().min(0).optional(),
    quantity: z.number().int().min(1),
    productCostMultiplier: z.number().default(2),
    // Optional: when omitted, resolved server-side to the first active lane
    // of the active DTF config (never a hard-coded lane key).
    tierPriceLane: z.string().min(1).max(20).optional(),
  })
  .refine((d) => {
    const sourceCount = [d.sku, d.productCost, d.catalogVariantId].filter(
      (value) => value != null
    ).length;
    return sourceCount === 1;
  }, {
    message: "Choose exactly one of sku, productCost, or catalogVariantId.",
  });

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

  const parsed = RequestBodySchema.safeParse(body);

  if (!parsed.success) {
    const flattened = parsed.error.flatten();
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

  // Resolve active DTF config for tiers and lanes
  const configResult = await resolveActiveConfig("dtf_matrix");
  if (!configResult.ok) {
    return NextResponse.json(
      { error: { _form: [configResult.error] } },
      { status: 503 }
    );
  }

  const dtfConfig: DtfMatrixConfig =
    configResult.source === "database"
      ? (configResult.version.data as DtfMatrixConfig)
      : configResult.data as DtfMatrixConfig;

  // Resolve lane: use the requested lane if it's active, otherwise default
  // to the first active lane of the active config (never a hard-coded key).
  const activeLanes = dtfConfig.lanes.filter((l) => l.active);
  const activeLaneKeys = new Set(activeLanes.map((l) => l.key));
  const requestedLane = parsed.data.tierPriceLane;

  if (requestedLane != null && !activeLaneKeys.has(requestedLane)) {
    return NextResponse.json(
      {
        error: {
          tierPriceLane: [
            `Unknown pricing lane "${requestedLane}". Available: ${[...activeLaneKeys].join(", ")}`,
          ],
        },
      },
      { status: 422 }
    );
  }

  if (activeLanes.length === 0) {
    return NextResponse.json(
      { error: { _form: ["No active pricing lanes are configured."] } },
      { status: 503 }
    );
  }

  const tierPriceLane = requestedLane ?? activeLanes[0].key;

  let productCost = parsed.data.productCost;
  let vendorCatalogProvenance: CatalogVariantCostResolution | undefined;

  // Resolve SKU to cost server-side
  if (parsed.data.sku && productCost == null) {
    const resolved = resolveProductCost(parsed.data.sku);
    if (resolved == null) {
      return NextResponse.json(
        { error: { sku: [`Unknown SKU: ${parsed.data.sku}`] } },
        { status: 400 }
      );
    }
    productCost = resolved;
  }

  if (parsed.data.catalogVariantId && productCost == null) {
    const status = await getVendorCatalogStatus();
    if (!status.available) {
      return NextResponse.json(
        {
          error: {
            catalogVariantId: ["Vendor catalog is unavailable."],
            _form: status.reason ? [status.reason] : undefined,
          },
        },
        { status: 503 }
      );
    }

    const resolved = await resolveCatalogVariantCost(parsed.data.catalogVariantId);
    if (resolved == null) {
      return NextResponse.json(
        {
          error: {
            catalogVariantId: [
              `Unknown catalog variant: ${parsed.data.catalogVariantId}`,
            ],
          },
        },
        { status: 400 }
      );
    }
    if (resolved.discontinued) {
      return NextResponse.json(
        {
          error: {
            catalogVariantId: [
              "Catalog variant is discontinued and cannot be quoted.",
            ],
          },
        },
        { status: 400 }
      );
    }
    productCost = resolved.unitCost;
    vendorCatalogProvenance = resolved;
  }

  const qtyValidation = validateQuantity(parsed.data.quantity);

  if (qtyValidation.requiresManagerReview) {
    return NextResponse.json({
      requiresManagerReview: true,
      message: "Quantities over 5,000 require manager review.",
    });
  }

  let input;
  try {
    input = ItemPriceInputSchema.parse({
      productCost,
      quantity: parsed.data.quantity,
      productCostMultiplier: parsed.data.productCostMultiplier,
      tierPriceLane,
    });
  } catch (e) {
    const message = e instanceof z.ZodError
      ? e.errors.map((err) => err.message).join("; ")
      : e instanceof Error ? e.message : "Validation failed";
    return NextResponse.json(
      { error: { _form: [message] } },
      { status: 422 }
    );
  }

  // Resolve projection level: auth-aware when CMP_AUTH_ENABLED=true,
  // otherwise falls back to legacy preview/local-manager behavior.
  const projection = await resolveAuthenticatedProjection(request);
  const isManager = projection === "manager";

  // Pass dynamic tiers from config
  const dynamicTiers = dtfConfig.tiers;

  try {
    const result = isManager
      ? quoteItemManager(input, dynamicTiers)
      : quoteItemStaff(input, dynamicTiers);

    return NextResponse.json({
      ...result,
      ...(isManager && vendorCatalogProvenance
        ? {
            vendorCatalog: {
              vendor: vendorCatalogProvenance.vendor,
              variantId: vendorCatalogProvenance.variantId,
              styleId: vendorCatalogProvenance.styleId,
              styleCode: vendorCatalogProvenance.styleCode,
              color: vendorCatalogProvenance.color,
              size: vendorCatalogProvenance.size,
              unitCost: vendorCatalogProvenance.unitCost,
              costBasis: vendorCatalogProvenance.costBasis,
              sourceSyncAt: vendorCatalogProvenance.sourceSyncAt,
            },
          }
        : {}),
      requiresManagerReview: false,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Calculation failed";
    return NextResponse.json(
      { error: { _form: [message] } },
      { status: 422 }
    );
  }
}
