import { notFound, redirect } from "next/navigation";
import {
  isPricingConfigEditorEnabled,
  isAuthenticatedProductionFeaturesEnabled,
} from "@/lib/server/pricing-preview-gate";
import { isUserAccessEnabled, requirePageAccess } from "@/lib/server/auth/access-resolution";
import { isAuthEnabled } from "@/lib/server/auth/policy";
import { isPricingConfigEnabled } from "@/lib/server/pricing-config/gate";
import AdminHeader from "../_components/AdminHeader";
import DtfMatrixEditor from "../_components/DtfMatrixEditor";
import AdditionalPrintsEditor from "../_components/AdditionalPrintsEditor";

export const metadata = {
  title: "Pricing Configuration - CMP Pricing",
};

export const dynamic = "force-dynamic";

export default async function PricingPage() {
  if (isAuthEnabled() && isUserAccessEnabled()) {
    const guard = await requirePageAccess("admin_access");
    if (!guard.allowed) redirect(guard.redirect);
  }

  if (!isPricingConfigEditorEnabled()) {
    notFound();
  }

  const configEnabled = isPricingConfigEnabled();

  return (
    <div className="min-h-screen flex flex-col bg-neutral-900">
      <AdminHeader
        activeSection="pricing"
        pricingPreviewEnabled
        userAccessEnabled={isUserAccessEnabled()}
        authenticatedProduction={isAuthenticatedProductionFeaturesEnabled()}
      />
      <main className="flex-1 px-4 py-5 max-w-7xl mx-auto w-full space-y-8">
        {/* One unified DTF matrix: the editor owns structure, prices, DTF GM%,
            calculation context, and Quote Impact. There is deliberately no
            second read-only DTF grid on this page. */}
        <section aria-labelledby="dtf-matrix-heading">
          <DtfMatrixEditor persistenceEnabled={configEnabled} />
        </section>

        <section aria-labelledby="ap-matrix-heading">
          <AdditionalPrintsEditor persistenceEnabled={configEnabled} />
        </section>
      </main>
    </div>
  );
}
