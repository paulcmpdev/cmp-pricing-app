import { getCatalogEntries } from "@/lib/server/catalog";
import QuoteDeskClient from "./concepts/quote-desk/QuoteDeskClient";
import Image from "next/image";

export const metadata = {
  title: "Quote Desk - CMP Pricing",
};

export default function RootPage() {
  const catalog = getCatalogEntries();

  return (
    <div className="min-h-screen flex flex-col bg-cmp-surface">
      {/* Header */}
      <header className="bg-cmp-charcoal px-4 py-3 flex items-center gap-4 shrink-0">
        <Image
          src="/brand/icon-cyan.png"
          alt="CMP"
          width={28}
          height={28}
          className="h-7 w-auto"
        />
        <div className="flex-1">
          <h1 className="text-white text-sm font-bold tracking-wide font-display">
            QUOTE DESK
          </h1>
        </div>
        <Image
          src="/brand/logo-dark.png"
          alt="Compound Sportswear"
          width={140}
          height={32}
          className="h-6 w-auto hidden sm:block"
        />
      </header>

      {/* Main content */}
      <main className="flex-1">
        <QuoteDeskClient catalog={catalog} mode="primary" />
      </main>
    </div>
  );
}
