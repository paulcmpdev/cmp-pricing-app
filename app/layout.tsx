import type { Metadata } from "next";
import SessionProvider from "@/lib/client/auth/SessionProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "CMP Pricing - Compound Sportswear",
  description: "Internal DTF item-price calculator",
  icons: { icon: "/brand/icon-cyan.png" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
