import { z } from 'zod';
import { adminProcedure, router } from '../trpc.js';

const removed = new Set<string>();

export const adminRouter = router({
  users: router({
    delete: adminProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(({ input }) => removed.add(input.id).size),
  }),
});
