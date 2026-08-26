/**
 * NextAuth v4 configuration for Google Workspace authentication.
 *
 * - Google OAuth provider
 * - JWT sessions (no database)
 * - Domain restriction to CMP_ALLOWED_GOOGLE_DOMAIN
 * - Server-derived roles embedded in JWT
 */
import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { isAllowedDomain, resolveRole } from "./policy";

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    async signIn({ profile }) {
      const email = profile?.email;
      const emailVerified = (profile as { email_verified?: boolean })
        ?.email_verified;
      if (!emailVerified) return false;

      const allowedDomain = process.env.CMP_ALLOWED_GOOGLE_DOMAIN;
      if (!allowedDomain) return false;

      return isAllowedDomain(email, allowedDomain);
    },
    async jwt({ token, profile }) {
      if (profile?.email) {
        token.email = profile.email.toLowerCase().trim();
        token.role = resolveRole(token.email as string);
        token.name = profile.name;
        token.picture = (profile as { picture?: string }).picture;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.email = token.email as string;
        session.user.name = token.name as string;
        (session.user as { role?: string }).role = token.role as string;
        session.user.image = token.picture as string;
      }
      return session;
    },
  },
};
