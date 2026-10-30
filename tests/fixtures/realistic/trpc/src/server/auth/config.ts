import { PrismaAdapter } from "@auth/prisma-adapter";
import type { DefaultSession, NextAuthConfig } from "next-auth";
import DiscordProvider from "next-auth/providers/discord";

import { db } from "~/server/db";

export type Role = "member" | "admin";

declare module "next-auth" {
  interface Session extends DefaultSession {
    user: { id: string; role: Role } & DefaultSession["user"];
  }

  interface User {
    role: Role;
  }
}

export const authConfig = {
  providers: [DiscordProvider],
  adapter: PrismaAdapter(db),
  callbacks: {
    session: ({ session, user }) => ({
      ...session,
      user: { ...session.user, id: user.id, role: user.role },
    }),
  },
} satisfies NextAuthConfig;
