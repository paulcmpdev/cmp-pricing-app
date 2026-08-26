import {
  isAuthenticatedProductionFeaturesEnabled,
  isPricingPreviewEnabled,
} from "@/lib/server/pricing-preview-gate";
import { isUserAccessEnabled, requirePageAccess } from "@/lib/server/auth/access-resolution";
import { isAuthEnabled } from "@/lib/server/auth/policy";
import AdminHeader from "../_components/AdminHeader";
import UserAccessDashboard from "./_components/UserAccessDashboard";
import { notFound, redirect } from "next/navigation";

export const metadata = {
  title: "Users & Access - CMP Pricing",
};

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  if (!isUserAccessEnabled()) {
    notFound();
  }

  if (isAuthEnabled()) {
    const guard = await requirePageAccess("admin_access");
    if (!guard.allowed) redirect(guard.redirect);
  }

  return (
    <div className="min-h-screen flex flex-col bg-neutral-900">
      <AdminHeader
        activeSection="users"
        pricingPreviewEnabled={isPricingPreviewEnabled()}
        userAccessEnabled
        authenticatedProduction={isAuthenticatedProductionFeaturesEnabled()}
      />
      <main className="flex-1 px-4 py-5 max-w-6xl mx-auto w-full">
        <UserAccessDashboard />
      </main>
    </div>
  );
}
