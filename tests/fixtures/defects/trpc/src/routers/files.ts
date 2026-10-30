import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { convert } from '../lib/convert.js';
import { protectedProcedure, publicProcedure, router } from '../trpc.js';

export const filesRouter = router({
  // Validated as a string, but the caller still chooses it.
  compress: protectedProcedure.input(z.string()).mutation(({ input }) => exec(`gzip ${input}`)),
  read: protectedProcedure
    .input(z.object({ path: z.string() }))
    .query((opts) => readFile(opts.input.path, 'utf8')),
  convert: protectedProcedure
    .input(z.object({ name: z.string() }))
    .mutation(({ input }) => convert(input.name)),
  upload: publicProcedure.input(z.any()).mutation(({ input }) => ({ received: input })),
  rename: protectedProcedure
    .input((value) => value as { from: string; to: string })
    .mutation(({ input }) => `${input.from} -> ${input.to}`),
});
