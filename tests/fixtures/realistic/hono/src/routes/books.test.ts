import { describe, expect, it } from 'vitest';
import books from './books.js';

describe('books routes', () => {
  it('rejects an invalid book', async () => {
    const response = await books.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', year: 'soon' }),
    });
    expect(response.status).toBe(400);
  });

  it('creates a valid book', async () => {
    const response = await books.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Dune', author: 'Frank Herbert', year: 1965 }),
    });
    expect(response.status).toBe(201);
  });
});
