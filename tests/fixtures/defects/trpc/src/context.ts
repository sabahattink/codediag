import type { CreateHTTPContextOptions } from '@trpc/server/adapters/standalone';
import { verifySession } from './lib/session.js';

export async function createContext({ req }: CreateHTTPContextOptions) {
  return { user: await verifySession(req.headers.authorization) };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
