"use client";

import { signOut } from "next-auth/react";
import Image from "next/image";
import Link from "next/link";

export default function UnauthorizedPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-cmp-charcoal px-4">
      <div className="w-full max-w-sm space-y-8 text-center">
        <div className="space-y-4">
          <Image
            src="/brand/icon-cyan.png"
            alt="CMP"
            width={48}
            height={48}
            className="mx-auto h-12 w-auto"
          />
          <h1 className="text-2xl font-bold text-white font-display tracking-wide">
            ACCESS RESTRICTED
          </h1>
        </div>

        <div className="rounded-md bg-amber-900/30 border border-amber-700 px-4 py-3 text-sm text-amber-200">
          You are signed in but do not have the required role to access this
          page. Contact an administrator if you believe this is an error.
        </div>

        <div className="flex gap-3 justify-center">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-md bg-cmp-cyan px-4 py-2 text-sm font-semibold text-white hover:bg-cmp-cyan-dark transition-colors"
          >
            Go to Quote Desk
          </Link>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="inline-flex items-center justify-center rounded-md border border-cmp-gray px-4 py-2 text-sm font-medium text-cmp-gray hover:text-white hover:border-white transition-colors"
          >
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
}
