import React from "react";
import Image from "next/image";
import Link from "next/link";
import UserMenu from "@/lib/client/auth/UserMenu";

const SECTION_TITLES = {
  catalog: "CATALOG OPERATIONS",
  pricing: "PRICING PREVIEW",
  users: "USERS & ACCESS",
} as const;

export default function AdminHeader({
  activeSection,
  pricingPreviewEnabled,
  userAccessEnabled = false,
  authenticatedProduction = false,
}: {
  activeSection: "catalog" | "pricing" | "users";
  pricingPreviewEnabled: boolean;
  userAccessEnabled?: boolean;
  authenticatedProduction?: boolean;
}) {
  const previewStatus = authenticatedProduction
    ? activeSection === "pricing"
      ? "Authenticated production · Persistent pricing"
      : activeSection === "users"
        ? "Authenticated production · Access control"
        : "Authenticated production · Read-only"
    : activeSection === "pricing"
      ? "Private preview · Session only"
      : activeSection === "users"
        ? "Access control"
        : "Private preview · Read-only";

  const sectionLinks: Array<{ href: string; label: string }> = [];
  if (activeSection !== "catalog") {
    sectionLinks.push({ href: "/admin", label: "Catalog Operations" });
  }
  if (activeSection !== "pricing" && pricingPreviewEnabled) {
    sectionLinks.push({ href: "/admin/pricing", label: "Pricing Preview" });
  }
  if (activeSection !== "users" && userAccessEnabled) {
    sectionLinks.push({ href: "/admin/users", label: "Users & Access" });
  }

  const navLinks = sectionLinks.map((link) => (
    <Link
      key={link.href}
      href={link.href}
      className="inline-flex min-h-[44px] shrink-0 items-center whitespace-nowrap text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
    >
      {link.label}
    </Link>
  ));

  return (
    <>
      <header className="bg-neutral-950 px-4 py-3 shrink-0 border-b border-neutral-800">
        <div className="flex items-center gap-3 sm:gap-4">
          <Image
            src="/brand/icon-cyan.png"
            alt="CMP"
            width={28}
            height={28}
            className="h-7 w-auto shrink-0"
          />
          <h1 className="min-w-0 flex-1 truncate text-white text-sm font-bold tracking-wide font-display sm:flex-none">
            {SECTION_TITLES[activeSection]}
          </h1>
          <nav
            className="hidden min-w-0 flex-1 items-center gap-3 overflow-x-auto sm:flex"
            aria-label="Admin sections"
          >
            {navLinks}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            <UserMenu compactOnMobile />
            <span className="hidden text-[10px] uppercase tracking-wider text-neutral-400 xl:inline">
              {previewStatus}
            </span>
            <Link
              href="/"
              className="hidden min-h-[44px] items-center text-xs text-neutral-400 hover:text-cmp-cyan transition-colors sm:inline-flex"
            >
              Quote Desk
            </Link>
            <Image
              src="/brand/logo-dark.png"
              alt="Compound Sportswear"
              width={140}
              height={32}
              className="hidden h-5 w-auto xl:block"
            />
          </div>
        </div>
        <div
          className="mt-2 flex items-center gap-3 sm:hidden"
          data-testid="admin-mobile-nav"
        >
          <nav
            className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto"
            aria-label="Admin sections"
          >
            {navLinks}
          </nav>
          <Link
            href="/"
            className="inline-flex min-h-[44px] shrink-0 items-center text-xs text-neutral-400 hover:text-cmp-cyan transition-colors"
          >
            Quote Desk
          </Link>
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
