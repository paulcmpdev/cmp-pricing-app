import { getAdminCatalogOverview } from "@/lib/server/vendor-catalog/repository";
import { isPricingPreviewEnabled } from "@/lib/server/pricing-preview-gate";
import AdminHeader from "./_components/AdminHeader";
import AdminDashboard from "./_components/AdminDashboard";

export const metadata = {
  title: "Catalog Operations - CMP Pricing",
};

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const overview = await getAdminCatalogOverview();

  return (
    <div className="min-h-screen flex flex-col bg-neutral-900">
      <AdminHeader
        activeSection="catalog"
        pricingPreviewEnabled={isPricingPreviewEnabled()}
      />
      <main className="flex-1 px-4 py-5 max-w-6xl mx-auto w-full">
        <AdminDashboard overview={overview} />
      </main>
    </div>
  );
}
