import { NextRequest, NextResponse } from "next/server";
import {
  getVendorCatalogStatus,
  getVendorCatalogStyleVariants,
} from "@/lib/server/vendor-catalog/repository";
import { requireRole } from "@/lib/server/auth/route-guards";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ styleId: string }> }
) {
  const authError = await requireRole(request, "view_quotes");
  if (authError) return authError;

  const status = await getVendorCatalogStatus();
  if (!status.available) {
    return NextResponse.json(
      {
        available: false,
        error: "Vendor catalog is unavailable.",
        reason: status.reason,
        variants: [],
      },
      { status: 503 }
    );
  }

  const { styleId: encodedStyleId } = await params;
  const styleId = decodeURIComponent(encodedStyleId);
  return NextResponse.json({
    available: true,
    variants: await getVendorCatalogStyleVariants(styleId),
  });
}
