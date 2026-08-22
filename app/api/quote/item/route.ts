import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ItemPriceInputSchema } from "@/lib/pricing/schemas";
import { quoteItemStaff, quoteItemManager } from "@/lib/server/quote-service";
import { resolveProductCost } from "@/lib/server/catalog";
import { validateQuantity } from "@/lib/pricing/quantity";

/**
 * Accepts either { productCost } directly or { sku } to resolve cost server-side.
 * The client never needs to know product costs.
 */
const RequestBodySchema = z
  .object({
    sku: z.string().optional(),
    productCost: z.number().min(0).optional(),
    quantity: z.number().int().min(1),
    productCostMultiplier: z.number().default(2),
    tierPriceLane: z.enum(["T1", "T2", "T3", "T4"]).default("T1"),
  })
  .refine((d) => d.sku != null || d.productCost != null, {
    message: "Either sku or productCost is required",
  });

export async function POST(request: NextRequest) {
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
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  let productCost = parsed.data.productCost;

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
      tierPriceLane: parsed.data.tierPriceLane,
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

  const role = request.headers.get("x-cmp-role");
  const isManager = role === "manager";

  try {
    const result = isManager
      ? quoteItemManager(input)
      : quoteItemStaff(input);

    return NextResponse.json({
      ...result,
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
