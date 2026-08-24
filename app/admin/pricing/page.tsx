import { notFound } from "next/navigation";
import { isPricingPreviewEnabled } from "@/lib/server/pricing-preview-gate";
import AdminHeader from "../_components/AdminHeader";
import PricingPreview from "../_components/PricingPreview";

export const metadata = {
  title: "Pricing Preview - CMP Pricing",
};

export const dynamic = "force-dynamic";

export default async function PricingPage() {
  if (!isPricingPreviewEnabled()) {
    notFound();
  }

  return (
    <div className="min-h-screen flex flex-col bg-neutral-900">
      <AdminHeader activeSection="pricing" pricingPreviewEnabled />
      <main className="flex-1 px-4 py-5 max-w-7xl mx-auto w-full">
        <PricingPreview />
      </main>
    </div>
  );
}
