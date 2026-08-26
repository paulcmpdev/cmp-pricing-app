"use client";

import { useSession, signOut } from "next-auth/react";
import Link from "next/link";

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  sales_rep: "Sales Rep",
};

export default function UserMenu({
  showAdminLink = false,
  compactOnMobile = false,
}: {
  showAdminLink?: boolean;
  compactOnMobile?: boolean;
}) {
  const { data: session, status } = useSession();

  if (status !== "authenticated" || !session?.user) return null;

  const role = (session.user as { role?: string }).role ?? "unknown";

  return (
    <div className="flex items-center gap-2 sm:gap-3 text-xs" data-testid="user-menu">
      {compactOnMobile ? (
        <span
          className="hidden max-w-[180px] truncate text-cmp-gray lg:inline"
          data-testid="user-email"
        >
          {session.user.email}
        </span>
      ) : (
        <span
          className="max-w-[180px] truncate text-cmp-gray"
          data-testid="user-email"
        >
          {session.user.email}
        </span>
      )}
      <span
        className="px-1.5 py-0.5 rounded bg-cmp-cyan/20 text-cmp-cyan font-semibold uppercase tracking-wider"
        data-testid="user-role"
      >
        {ROLE_LABELS[role] ?? role}
      </span>
      {showAdminLink && role === "admin" && (
        <Link
          href="/admin"
          className="inline-flex min-h-[44px] items-center text-cmp-gray hover:text-cmp-cyan transition-colors"
        >
          Admin
        </Link>
      )}
      <button
        onClick={() => signOut({ callbackUrl: "/login" })}
        className="inline-flex min-h-[44px] items-center text-cmp-gray hover:text-white transition-colors"
        data-testid="sign-out-btn"
      >
        Sign Out
      </button>
    </div>
  );
}
