import { notFound } from "next/navigation";
import {
  isPricingPreviewEnabled,
  isAdditionalLocationsPreviewEnabled,
} from "@/lib/server/pricing-preview-gate";
import AdminHeader from "../_components/AdminHeader";
import PricingPreview from "../_components/PricingPreview";
import AdditionalLocationMatrixPreview from "../_components/AdditionalLocationMatrixPreview";

export const metadata = {
  title: "Pricing Preview - CMP Pricing",
};

export const dynamic = "force-dynamic";

export default function PricingPage() {
  if (!isPricingPreviewEnabled()) {
    notFound();
  }

  const showAdditionalLocations = isAdditionalLocationsPreviewEnabled();

  return (
    <div className="min-h-screen flex flex-col bg-neutral-900">
      <AdminHeader activeSection="pricing" pricingPreviewEnabled />
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
