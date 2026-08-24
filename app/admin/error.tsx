"use client";

import Link from "next/link";

export default function AdminError() {
  return (
    <div className="min-h-screen flex flex-col bg-neutral-900">
      <header className="bg-neutral-950 px-4 py-3 flex items-center gap-4 shrink-0 border-b border-neutral-800">
        <div className="h-7 w-7 rounded bg-neutral-800" />
        <div className="flex-1">
          <h1 className="text-white text-sm font-bold tracking-wide font-display">
            CATALOG OPERATIONS
          </h1>
        </div>
      </header>
      <main className="flex-1 px-4 py-5 max-w-6xl mx-auto w-full flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-lg font-semibold text-white font-display mb-2">
            Something went wrong
          </h2>
          <p className="text-sm text-neutral-400 mb-4">
            The admin dashboard could not be loaded. Please try again later.
          </p>
          <Link
            href="/"
            className="inline-flex min-h-11 items-center rounded border border-neutral-700 px-4 text-sm text-neutral-300 transition-colors hover:border-cmp-cyan/50 hover:text-cmp-cyan"
          >
            Return to Quote Desk
          </Link>
        </div>
      </main>
    </div>
  );
}
