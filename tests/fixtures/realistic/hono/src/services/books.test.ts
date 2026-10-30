import { describe, expect, it } from 'vitest';
import { addBook, getBook, removeBook, updateBook } from './books.js';

describe('books service', () => {
  it('adds, updates, and removes books', () => {
    const book = addBook({ title: 'Emma', author: 'Jane Austen', year: 1815 });
    expect(updateBook(book.id, { year: 1816 })?.year).toBe(1816);
    expect(removeBook(book.id)).toBe(true);
    expect(getBook(book.id)).toBeUndefined();
  });
});
