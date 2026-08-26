import { notFound, redirect } from "next/navigation";
import {
  isPricingPreviewEnabled,
  isAdditionalLocationsPreviewEnabled,
  isAuthenticatedProductionFeaturesEnabled,
} from "@/lib/server/pricing-preview-gate";
import { isUserAccessEnabled, requirePageAccess } from "@/lib/server/auth/access-resolution";
import { isAuthEnabled } from "@/lib/server/auth/policy";
import AdminHeader from "../_components/AdminHeader";
import PricingPreview from "../_components/PricingPreview";
import AdditionalLocationMatrixPreview from "../_components/AdditionalLocationMatrixPreview";

export const metadata = {
  title: "Pricing Preview - CMP Pricing",
};

export const dynamic = "force-dynamic";

export default async function PricingPage() {
  if (isAuthEnabled() && isUserAccessEnabled()) {
    const guard = await requirePageAccess("admin_access");
    if (!guard.allowed) redirect(guard.redirect);
  }

  if (!isPricingPreviewEnabled()) {
    notFound();
  }

  const showAdditionalLocations = isAdditionalLocationsPreviewEnabled();

  return (
    <div className="min-h-screen flex flex-col bg-neutral-900">
      <AdminHeader
        activeSection="pricing"
        pricingPreviewEnabled
        userAccessEnabled={isUserAccessEnabled()}
        authenticatedProduction={isAuthenticatedProductionFeaturesEnabled()}
      />
      <main className="flex-1 px-4 py-5 max-w-7xl mx-auto w-full space-y-8">
        <PricingPreview />
        {showAdditionalLocations && (
          <section aria-labelledby="al-matrix-heading">
            <AdditionalLocationMatrixPreview />
          </section>
        )}
      </main>
    </div>
  );
}
