import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/server/auth/route-guards";
import { readSameOriginJsonMutation } from "@/lib/server/auth/mutation-request";
import { isAuthEnabled } from "@/lib/server/auth/policy";
import { isUserAccessEnabled, getBootstrapAdminEmails } from "@/lib/server/auth/access-resolution";
import { getUserAccessRepository } from "@/lib/server/user-access/repository";
import type { AppUser, AppUserRole } from "@/lib/server/user-access/types";

const CMP_DOMAIN = "cmpsportswear.com";

const PreAuthorizeSchema = z.object({
  email: z
    .string()
    .email()
    .transform((e) => e.toLowerCase().trim())
    .refine((e) => e.endsWith(`@${CMP_DOMAIN}`), {
      message: `Only @${CMP_DOMAIN} emails are allowed.`,
    }),
  role: z.enum(["sales_rep", "manager", "admin"]),
});

export async function GET(request: NextRequest) {
  // Fail closed: user-access APIs require auth to be enabled
  if (!isAuthEnabled()) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const authError = await requireRole(request, "admin_access");
  if (authError) return authError;

  if (!isUserAccessEnabled()) {
    return NextResponse.json({ error: "User access feature is not enabled." }, { status: 404 });
  }

  try {
    const repo = getUserAccessRepository();
    const users = await repo.listUsers();

    // Merge bootstrap admin projections
    const bootstrapEmails = getBootstrapAdminEmails();
    const userEmails = new Set(users.map((u: AppUser) => u.email));
    const bootstrapProjections = bootstrapEmails
      .filter((e: string) => !userEmails.has(e))
      .map((email: string) => ({
        email,
        name: null,
        image: null,
        role: "admin" as AppUserRole,
        status: "active" as const,
        version: 0,
        createdAt: null,
        updatedAt: null,
        lastSignInAt: null,
        isBootstrapAdmin: true,
      }));

    // Bootstrap admins always project as active admin regardless of DB state
    const allUsers = [
      ...users.map((u: AppUser) => {
        const isBoot = bootstrapEmails.includes(u.email);
        return {
          ...u,
          role: isBoot ? ("admin" as AppUserRole) : u.role,
          status: isBoot ? ("active" as const) : u.status,
          isBootstrapAdmin: isBoot,
        };
      }),
      ...bootstrapProjections,
    ];

    // Recalculate every summary from the projected list so bootstrap overrides
    // cannot disagree with the table shown to the Admin.
    const counts = {
      pending: allUsers.filter((u) => u.status === "pending").length,
      active: allUsers.filter((u) => u.status === "active").length,
      disabled: allUsers.filter((u) => u.status === "disabled").length,
      admins: allUsers.filter(
        (u) => u.role === "admin" && u.status === "active"
      ).length,
    };

    return NextResponse.json({
      users: allUsers,
      counts,
    });
  } catch (err) {
    console.error("Failed to list users:", err);
    return NextResponse.json(
      { error: "User access database is unavailable." },
      { status: 503 }
    );
  }
}

export async function POST(request: NextRequest) {
  // Fail closed: user-access APIs require auth to be enabled
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
  const body = mutation.body;

  const parsed = PreAuthorizeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  // Get actor email from session
  const { getAuthSession } = await import("@/lib/server/auth/route-guards");
  const session = await getAuthSession(request);
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const repo = getUserAccessRepository();
    const result = await repo.preAuthorize({
      email: parsed.data.email,
      role: parsed.data.role,
      actorEmail: session.email,
    });

    if (!result.ok) {
      const statusMap = { conflict: 409, forbidden: 403, not_found: 404, unavailable: 503 } as const;
      return NextResponse.json(
        { error: result.reason === "conflict" || result.reason === "forbidden" ? result.message : "Operation failed." },
        { status: statusMap[result.reason] }
      );
    }

    return NextResponse.json({ user: result.user, event: result.event }, { status: 201 });
  } catch (err) {
    console.error("Failed to pre-authorize user:", err);
    return NextResponse.json(
      { error: "User access database is unavailable." },
      { status: 503 }
    );
  }
}
