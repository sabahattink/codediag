import { z } from 'zod';
import { isAuthed, publicProcedure, router } from '../trpc.js';

const posts: string[] = [];
const authedProcedure = publicProcedure;
// Builders are immutable: the protected builder this returns is discarded.
authedProcedure.use(isAuthed);

export const postsRouter = router({
  list: publicProcedure.query(() => posts),
  create: authedProcedure
    .input(z.object({ title: z.string().min(1) }))
    .mutation(({ input }) => posts.push(input.title)),
});
