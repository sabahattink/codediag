import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { createBookSchema, idParamSchema, updateBookSchema } from '../schemas/book.js';
import { addBook, getBook, listBooks, removeBook, updateBook } from '../services/books.js';

// Chained so that hono/client can infer the route types.
const books = new Hono()
  .get('/', (c) => c.json(listBooks()))
  .get('/:id', zValidator('param', idParamSchema), (c) => {
    const book = getBook(c.req.valid('param').id);
    return book ? c.json(book) : c.json({ message: 'Not Found' }, 404);
  })
  .post('/', zValidator('json', createBookSchema), (c) => c.json(addBook(c.req.valid('json')), 201))
  .patch(
    '/:id',
    zValidator('param', idParamSchema),
    zValidator('json', updateBookSchema),
    (c) => {
      const book = updateBook(c.req.valid('param').id, c.req.valid('json'));
      return book ? c.json(book) : c.json({ message: 'Not Found' }, 404);
    },
  )
  .delete('/:id', zValidator('param', idParamSchema), (c) =>
    removeBook(c.req.valid('param').id) ? c.body(null, 204) : c.json({ message: 'Not Found' }, 404),
  );

export default books;
