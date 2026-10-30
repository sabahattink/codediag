import { z } from "zod";

import {
  adminProcedure,
  createTRPCRouter,
  protectedProcedure,
} from "~/server/api/trpc";

export const userRouter = createTRPCRouter({
  me: protectedProcedure.query(({ ctx }) => ctx.session.user),

  updateName: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(64) }))
    .mutation(({ ctx, input }) =>
      ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { name: input.name },
      }),
    ),

  setRole: adminProcedure
    .input(
      z.object({ userId: z.string().cuid(), role: z.enum(["member", "admin"]) }),
    )
    .mutation(({ ctx, input }) =>
      ctx.db.user.update({
        where: { id: input.userId },
        data: { role: input.role },
      }),
    ),
});
