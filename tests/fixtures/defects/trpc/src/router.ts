import { adminRouter } from './routers/admin.js';
import { filesRouter } from './routers/files.js';
import { postsRouter } from './routers/posts.js';
import { mergeRouters, publicProcedure, router } from './trpc.js';

export const appRouter = mergeRouters(
  router({ health: publicProcedure.query(() => 'ok'), admin: adminRouter }),
  router({ files: filesRouter, posts: postsRouter }),
);

export type AppRouter = typeof appRouter;
