import { initTRPC, TRPCError } from '@trpc/server';
import type { Context } from './context.js';

const t = initTRPC.context<Context>().create({
  // Turns on stack traces in every environment, production included.
  isDev: true,
  errorFormatter({ shape, error }) {
    return { ...shape, data: { ...shape.data, stack: error.stack } };
  },
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;

const logger = t.middleware(async ({ path, next }) => {
  const result = await next();
  console.info(`${path}: ${result.ok ? 'ok' : 'failed'}`);
  return result;
});

export const isAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({ ctx: { user: ctx.user } });
});

export const publicProcedure = t.procedure.use(logger);
export const protectedProcedure = t.procedure.use(logger).use(isAuthed);
// Named like an admin builder, but it only logs.
export const adminProcedure = t.procedure.use(logger);
