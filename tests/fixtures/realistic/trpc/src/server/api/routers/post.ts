import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "~/server/api/trpc";

const postId = z.object({ id: z.number().int().positive() });

export const postRouter = createTRPCRouter({
  latest: publicProcedure.query(({ ctx }) =>
    ctx.db.post.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
  ),

  byId: publicProcedure
    .input(postId)
    .query(({ ctx, input }) => ctx.db.post.findUnique({ where: { id: input.id } })),

  create: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(256) }))
    .mutation(({ ctx, input }) =>
      ctx.db.post.create({
        data: {
          name: input.name,
          createdBy: { connect: { id: ctx.session.user.id } },
        },
      }),
    ),

  delete: protectedProcedure.input(postId).mutation(async ({ ctx, input }) => {
    const post = await ctx.db.post.findUnique({ where: { id: input.id } });
    if (post?.createdById !== ctx.session.user.id) {
      throw new TRPCError({ code: "NOT_FOUND" });
    }
    return ctx.db.post.delete({ where: { id: input.id } });
  }),
});
