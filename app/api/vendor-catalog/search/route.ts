import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getVendorCatalogStatus,
  searchVendorCatalogStyles,
} from "@/lib/server/vendor-catalog/repository";

const SearchParamsSchema = z.object({
  q: z.string().transform((value) => value.trim()),
  vendor: z.enum(["all", "ss", "sanmar"]).default("all"),
});

export async function GET(request: NextRequest) {
  const parsed = SearchParamsSchema.safeParse({
    q: request.nextUrl.searchParams.get("q") ?? "",
    vendor: request.nextUrl.searchParams.get("vendor") ?? "all",
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  if (parsed.data.q.length < 2) {
    return NextResponse.json(
      {
        error: {
          q: ["Search requires at least two non-space characters."],
        },
      },
      { status: 400 }
    );
  }

  const status = getVendorCatalogStatus();
  if (!status.available) {
    return NextResponse.json(
      {
        available: false,
        error: "Vendor catalog is unavailable.",
        reason: status.reason,
        results: [],
      },
      { status: 503 }
    );
  }

  return NextResponse.json({
    available: true,
    results: searchVendorCatalogStyles({
      query: parsed.data.q,
      vendor: parsed.data.vendor,
    }),
  });
}
