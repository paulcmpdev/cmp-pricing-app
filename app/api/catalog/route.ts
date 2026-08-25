import { NextRequest, NextResponse } from "next/server";
import { getCatalogEntries } from "@/lib/server/catalog";
import { requireRole } from "@/lib/server/auth/route-guards";

export async function GET(request: NextRequest) {
  const authError = await requireRole(request, "view_quotes");
  if (authError) return authError;

  return NextResponse.json(getCatalogEntries());
}
