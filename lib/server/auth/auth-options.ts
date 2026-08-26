/**
 * NextAuth v4 configuration for Google Workspace authentication.
 *
 * - Google OAuth provider
 * - JWT sessions (no database)
 * - Domain restriction to CMP_ALLOWED_GOOGLE_DOMAIN
 * - Server-derived roles embedded in JWT
 *
 * When CMP_USER_ACCESS_ENABLED=true, unknown verified users are
 * inserted as pending and the signIn callback redirects to
 * /pending-access. Bootstrap admin emails always pass through.
 */
import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { isAllowedDomain, resolveRole } from "./policy";
import {
  isUserAccessEnabled,
  isBootstrapAdmin,
  resolveAccessFromUser,
} from "./access-resolution";

async function handleUserAccessSignIn(
  email: string,
  name: string | null,
  image: string | null
): Promise<boolean | string> {
  // Bootstrap admins always pass
  if (isBootstrapAdmin(email)) return true;

  try {
    const { getUserAccessRepository, isUserAccessDatabaseConfigured } =
      await import("../user-access/repository");

    if (!isUserAccessDatabaseConfigured()) {
      // No DB configured: fail-closed for non-bootstrap users
      return "/pending-access";
    }

    const repo = getUserAccessRepository();
    const result = await repo.requestAccess({ email, name, image });

    if (!result.ok) {
      return "/pending-access";
    }

    const user = result.user;
    if (user.status === "active" && user.role) {
      return true;
    }

    // Pending or disabled
    return "/pending-access";
  } catch {
    // Database unavailable: fail-closed, only bootstrap admins pass
    return "/pending-access";
  }
}

async function resolveCurrentAccessRole(email: string) {
  if (isBootstrapAdmin(email)) return "admin" as const;

  try {
    const { getUserAccessRepository, isUserAccessDatabaseConfigured } =
      await import("../user-access/repository");
    if (!isUserAccessDatabaseConfigured()) return null;

    const user = await getUserAccessRepository().getUser(email);
    return resolveAccessFromUser(email, user)?.role ?? null;
  } catch {
    return null;
  }
}

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

      if (!isAllowedDomain(email, allowedDomain)) return false;

      // User access feature gate
      if (isUserAccessEnabled()) {
        const normalized = email!.toLowerCase().trim();
        const name = profile?.name ?? null;
        const image = (profile as { picture?: string })?.picture ?? null;
        return handleUserAccessSignIn(normalized, name, image);
      }

      return true;
    },
    async jwt({ token, profile }) {
      if (profile?.email) {
        token.email = profile.email.toLowerCase().trim();
        token.name = profile.name;
        token.picture = (profile as { picture?: string }).picture;
      }

      if (token.email) {
        if (isUserAccessEnabled()) {
          const role = await resolveCurrentAccessRole(token.email as string);
          if (role) token.role = role;
          else delete token.role;
        } else if (profile?.email) {
          token.role = resolveRole(token.email as string);
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.email = token.email as string;
        session.user.name = token.name as string;
        (session.user as { role?: string }).role = token.role as
          | string
          | undefined;
        session.user.image = token.picture as string;
      }
      return session;
    },
  },
};
