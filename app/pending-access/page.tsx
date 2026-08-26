import Image from "next/image";
import Link from "next/link";

export const metadata = { title: "Pending Access - CMP Pricing" };

export default function PendingAccessPage() {
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
            ACCESS PENDING
          </h1>
        </div>

        <div className="rounded-md bg-amber-900/30 border border-amber-700 px-4 py-4 text-sm text-amber-200 space-y-2">
          <p className="font-medium">Your access request has been received.</p>
          <p className="text-amber-300/80">
            A CMP administrator needs to approve your account before you can
            use the application. You&apos;ll be able to sign in once approved.
          </p>
        </div>

        <Link
          href="/login"
          className="inline-block text-sm text-cmp-gray hover:text-white transition-colors"
        >
          Return to sign in
        </Link>
      </div>
    </div>
  );
}
