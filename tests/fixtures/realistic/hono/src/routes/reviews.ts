import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { requireRole } from '../middleware/require-role.js';
import { createReviewSchema, idParamSchema } from '../schemas/book.js';

interface Review {
  id: string;
  bookId: string;
  rating: number;
  text: string;
}

const store = new Map<string, Review>();

const reviews = new Hono();

reviews.get('/', (c) => c.json([...store.values()]));

reviews.post('/', zValidator('json', createReviewSchema), (c) => {
  const review = { id: randomUUID(), ...c.req.valid('json') };
  store.set(review.id, review);
  return c.json(review, 201);
});

reviews.delete('/:id', requireRole('moderator'), zValidator('param', idParamSchema), (c) =>
  store.delete(c.req.valid('param').id) ? c.body(null, 204) : c.json({ message: 'Not Found' }, 404),
);

export default reviews;
