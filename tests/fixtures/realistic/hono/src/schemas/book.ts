import { z } from 'zod';

export const idParamSchema = z.object({ id: z.string().uuid() });

export const createBookSchema = z.object({
  title: z.string().min(1).max(200),
  author: z.string().min(1).max(120),
  year: z.number().int().min(1450).max(2100),
});

export const updateBookSchema = createBookSchema.partial();

export const createReviewSchema = z.object({
  bookId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  text: z.string().max(2000),
});

export type CreateBookInput = z.infer<typeof createBookSchema>;
export type UpdateBookInput = z.infer<typeof updateBookSchema>;
export type BookRecord = CreateBookInput & { id: string };
