import { postRouter } from "~/server/api/routers/post";
import { userRouter } from "~/server/api/routers/user";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";

export const appRouter = createTRPCRouter({
  post: postRouter,
  user: userRouter,
});

export type AppRouter = typeof appRouter;

/** Calls procedures from server code: `await createCaller(ctx).post.latest()`. */
export const createCaller = createCallerFactory(appRouter);
