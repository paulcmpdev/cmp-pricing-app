import Image from "next/image";
import Link from "next/link";

const concepts = [
  {
    slug: "quote-desk",
    title: "Quote Desk",
    description:
      "Split-pane desktop layout. Inputs on the left, sticky quote summary on the right. Fastest path for repeat staff quoting.",
    available: true,
  },
] as const;

export default function ConceptsPage() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-cmp-charcoal px-6 py-4">
        <div className="mx-auto max-w-5xl flex items-center gap-4">
          <Image
            src="/brand/logo-dark.png"
            alt="Compound Sportswear"
            width={180}
            height={40}
            className="h-8 w-auto"
            priority
          />
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center px-4 py-12 sm:py-16">
        <div className="text-center mb-10">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-cmp-charcoal mb-2">
            Pricing Concepts
          </h1>
          <p className="text-sm text-cmp-gray max-w-md mx-auto">
            The working approach to the DTF item-price calculator.
          </p>
          <p className="mt-3 text-xs tracking-[0.25em] uppercase text-cmp-gray/60 font-display">
            Built. Different.
          </p>
        </div>

        {/* Concept Cards */}
        <div className="w-full max-w-3xl grid gap-4 sm:grid-cols-1">
          {concepts.map((concept) => {
            const inner = (
              <div
                className={`cmp-card p-6 h-full flex flex-col transition-all ${
                  concept.available
                    ? "hover:shadow-md hover:border-cmp-cyan cursor-pointer"
                    : "opacity-50"
                }`}
              >
                <h2 className="text-lg font-bold text-cmp-charcoal mb-2 font-display">
                  {concept.title}
                </h2>
                <p className="text-sm text-cmp-gray flex-1 mb-4">
                  {concept.description}
                </p>
                {concept.available ? (
                  <span className="cmp-btn-primary text-center text-sm">
                    Open
                  </span>
                ) : (
                  <span className="text-xs text-cmp-gray italic">
                    Coming soon
                  </span>
                )}
              </div>
            );

            return concept.available ? (
              <Link
                key={concept.slug}
                href={`/concepts/${concept.slug}`}
                className="focus-visible:outline-cmp-cyan rounded-lg"
              >
                {inner}
              </Link>
            ) : (
              <div key={concept.slug} aria-disabled="true">
                {inner}
              </div>
            );
          })}
        </div>
      </main>

      {/* Footer */}
      <footer className="py-4 text-center text-xs text-cmp-gray">
        Internal evaluation tool &mdash; not for customer distribution
      </footer>
    </div>
  );
}
