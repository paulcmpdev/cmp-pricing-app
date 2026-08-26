import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole, getAuthSession } from "@/lib/server/auth/route-guards";
import { readSameOriginJsonMutation } from "@/lib/server/auth/mutation-request";
import { isAuthEnabled } from "@/lib/server/auth/policy";
import { isUserAccessEnabled } from "@/lib/server/auth/access-resolution";
import { getUserAccessRepository } from "@/lib/server/user-access/repository";

const UserEmailSchema = z
  .string()
  .email()
  .transform((email) => email.toLowerCase().trim())
  .refine((email) => email.endsWith("@cmpsportswear.com"));

function parseRouteEmail(encodedEmail: string): string | null {
  try {
    const parsed = UserEmailSchema.safeParse(decodeURIComponent(encodedEmail));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const ApproveSchema = z.object({
  action: z.literal("approve"),
  role: z.enum(["sales_rep", "manager", "admin"]),
  expectedVersion: z.number().int().positive(),
});

const ChangeRoleSchema = z.object({
  action: z.literal("change_role"),
  role: z.enum(["sales_rep", "manager", "admin"]),
  expectedVersion: z.number().int().positive(),
});

const DisableSchema = z.object({
  action: z.literal("disable"),
  expectedVersion: z.number().int().positive(),
});

const ReEnableSchema = z.object({
  action: z.literal("re_enable"),
  role: z.enum(["sales_rep", "manager", "admin"]),
  expectedVersion: z.number().int().positive(),
});

const PatchSchema = z.discriminatedUnion("action", [
  ApproveSchema,
  ChangeRoleSchema,
  DisableSchema,
  ReEnableSchema,
]);

type RouteParams = { params: Promise<{ email: string }> };

export async function GET(request: NextRequest, props: RouteParams) {
  if (!isAuthEnabled()) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const authError = await requireRole(request, "admin_access");
  if (authError) return authError;

  if (!isUserAccessEnabled()) {
    return NextResponse.json({ error: "User access feature is not enabled." }, { status: 404 });
  }

  const { email } = await props.params;
  const decoded = parseRouteEmail(email);
  if (!decoded) {
    return NextResponse.json(
      { error: "A valid @cmpsportswear.com email is required." },
      { status: 400 }
    );
  }

  try {
    const repo = getUserAccessRepository();
    const [user, events] = await Promise.all([
      repo.getUser(decoded),
      repo.getUserEvents(decoded),
    ]);

    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    return NextResponse.json({ user, events });
  } catch (err) {
    console.error("Failed to get user:", err);
    return NextResponse.json(
      { error: "User access database is unavailable." },
      { status: 503 }
    );
  }
}

export async function PATCH(request: NextRequest, props: RouteParams) {
  if (!isAuthEnabled()) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const authError = await requireRole(request, "admin_access");
  if (authError) return authError;

  if (!isUserAccessEnabled()) {
    return NextResponse.json({ error: "User access feature is not enabled." }, { status: 404 });
  }

  const mutation = await readSameOriginJsonMutation(request);
  if (!mutation.ok) return mutation.response;

  const session = await getAuthSession(request);
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { email } = await props.params;
  const decoded = parseRouteEmail(email);
  if (!decoded) {
    return NextResponse.json(
      { error: "A valid @cmpsportswear.com email is required." },
      { status: 400 }
    );
  }

  const body = mutation.body;

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  try {
    const repo = getUserAccessRepository();
    const data = parsed.data;
    let result;

    switch (data.action) {
      case "approve":
        result = await repo.approveUser({
          email: decoded,
          role: data.role,
          actorEmail: session.email,
          expectedVersion: data.expectedVersion,
        });
        break;
      case "change_role":
        result = await repo.changeRole({
          email: decoded,
          role: data.role,
          actorEmail: session.email,
          expectedVersion: data.expectedVersion,
        });
        break;
      case "disable":
        result = await repo.disableUser({
          email: decoded,
          actorEmail: session.email,
          expectedVersion: data.expectedVersion,
        });
        break;
      case "re_enable":
        result = await repo.reEnableUser({
          email: decoded,
          role: data.role,
          actorEmail: session.email,
          expectedVersion: data.expectedVersion,
        });
        break;
    }

    if (!result.ok) {
      const statusMap = { conflict: 409, forbidden: 403, not_found: 404, unavailable: 503 } as const;
      return NextResponse.json(
        { error: "reason" in result && ("message" in result) ? result.message : "Operation failed." },
        { status: statusMap[result.reason] }
      );
    }

    return NextResponse.json({ user: result.user, event: result.event });
  } catch (err) {
    console.error("Failed to update user:", err);
    return NextResponse.json(
      { error: "User access database is unavailable." },
      { status: 503 }
    );
  }
}
