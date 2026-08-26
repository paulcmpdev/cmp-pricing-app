import { redirect } from "next/navigation";
import { isAuthEnabled } from "@/lib/server/auth/policy";
import {
  isUserAccessEnabled,
  requirePageAccess,
} from "@/lib/server/auth/access-resolution";

export const dynamic = "force-dynamic";

export default async function ConceptsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (isAuthEnabled() && isUserAccessEnabled()) {
    const guard = await requirePageAccess("admin_access");
    if (!guard.allowed) redirect(guard.redirect);
  }

  return <>{children}</>;
}
