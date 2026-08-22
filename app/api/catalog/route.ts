import { NextResponse } from "next/server";
import { getCatalogEntries } from "@/lib/server/catalog";

export async function GET() {
  return NextResponse.json(getCatalogEntries());
}
