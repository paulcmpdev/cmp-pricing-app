import React from "react";
import Image from "next/image";
import Link from "next/link";

const SECTION_TITLES = {
  catalog: "CATALOG OPERATIONS",
  pricing: "PRICING PREVIEW",
} as const;

export default function AdminHeader({
  activeSection,
  pricingPreviewEnabled,
}: {
  activeSection: "catalog" | "pricing";
  pricingPreviewEnabled: boolean;
}) {
  const previewStatus = activeSection === "pricing"
    ? "Private preview · Session only"
    : "Private preview · Read-only";

  return (
    <>
      <header className="bg-neutral-950 px-4 py-3 flex items-center gap-4 shrink-0 border-b border-neutral-800">
        <Image
          src="/brand/icon-cyan.png"
          alt="CMP"
          width={28}
          height={28}
          className="h-7 w-auto"
        />
        <div className="flex-1 min-w-0 flex items-center gap-4">
          <h1 className="text-white text-sm font-bold tracking-wide font-display">
            {SECTION_TITLES[activeSection]}
          </h1>
          <nav className="flex items-center gap-3" aria-label="Admin sections">
            {activeSection !== "catalog" && (
              <Link
                href="/admin"
                className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
              >
                Catalog Operations
              </Link>
            )}
            {activeSection !== "pricing" && pricingPreviewEnabled && (
              <Link
                href="/admin/pricing"
                className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
              >
                Pricing Preview
              </Link>
            )}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-wider text-neutral-400 hidden sm:inline">
            {previewStatus}
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
      <div className="sm:hidden bg-neutral-950 px-4 pb-2 border-b border-neutral-800">
        <span className="text-[10px] uppercase tracking-wider text-neutral-400">
          {previewStatus}
        </span>
      </div>
    </>
  );
}
