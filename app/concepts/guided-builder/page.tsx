import { getCatalogEntries } from "@/lib/server/catalog";
import GuidedBuilderClient from "./GuidedBuilderClient";
import Link from "next/link";
import Image from "next/image";

export const metadata = {
  title: "Guided Builder - CMP Pricing",
};

export default function GuidedBuilderPage() {
  const catalog = getCatalogEntries();

  return (
    <div className="min-h-screen flex flex-col bg-cmp-surface">
      {/* Header */}
      <header className="bg-cmp-charcoal px-4 py-3 flex items-center gap-4 shrink-0">
        <Link
          href="/concepts"
          className="focus-visible:outline-cmp-cyan rounded"
        >
          <Image
            src="/brand/icon-cyan.png"
            alt="Back to concepts"
            width={28}
            height={28}
            className="h-7 w-auto"
          />
        </Link>
        <div className="flex-1">
          <h1 className="text-white text-sm font-bold tracking-wide font-display">
            GUIDED BUILDER
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
        <GuidedBuilderClient catalog={catalog} />
      </main>
    </div>
  );
}
