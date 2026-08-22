import { NextRequest, NextResponse } from "next/server";
import {
  getVendorCatalogStatus,
  getVendorCatalogStyleVariants,
} from "@/lib/server/vendor-catalog/repository";

export async function GET(
  _request: NextRequest,
  { params }: { params: { styleId: string } }
) {
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

  const styleId = decodeURIComponent(params.styleId);
  return NextResponse.json({
    available: true,
    variants: await getVendorCatalogStyleVariants(styleId),
  });
}
