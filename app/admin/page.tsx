import Image from "next/image";
import Link from "next/link";
import { getAdminCatalogOverview } from "@/lib/server/vendor-catalog/repository";
import AdminDashboard from "./_components/AdminDashboard";

export const metadata = {
  title: "Catalog Operations - CMP Pricing",
};

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const overview = await getAdminCatalogOverview();

  return (
    <div className="min-h-screen flex flex-col bg-neutral-900">
      <header className="bg-neutral-950 px-4 py-3 flex items-center gap-4 shrink-0 border-b border-neutral-800">
        <Image
          src="/brand/icon-cyan.png"
          alt="CMP"
          width={28}
          height={28}
          className="h-7 w-auto"
        />
        <div className="flex-1 min-w-0">
          <h1 className="text-white text-sm font-bold tracking-wide font-display">
            CATALOG OPERATIONS
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-wider text-neutral-400 hidden sm:inline">
            Private preview &middot; Read-only
          </span>
          <Link
            href="/"
            className="text-xs text-neutral-400 hover:text-cmp-cyan transition-colors"
          >
            Quote Desk
          </Link>
          <Image
            src="/brand/logo-dark.png"
            alt="Compound Sportswear"
            width={140}
            height={32}
            className="h-5 w-auto hidden md:block"
          />
        </div>
      </header>

      {/* Mobile-only badge */}
      <div className="sm:hidden bg-neutral-950 px-4 pb-2 border-b border-neutral-800">
        <span className="text-[10px] uppercase tracking-wider text-neutral-400">
          Private preview &middot; Read-only
        </span>
      </div>

      <main className="flex-1 px-4 py-5 max-w-6xl mx-auto w-full">
        <AdminDashboard overview={overview} />
      </main>
    </div>
  );
}
