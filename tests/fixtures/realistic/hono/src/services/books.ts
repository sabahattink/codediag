import { randomUUID } from 'node:crypto';
import type { BookRecord, CreateBookInput, UpdateBookInput } from '../schemas/book.js';

const books = new Map<string, BookRecord>();

export function listBooks(): BookRecord[] {
  return [...books.values()];
}

export function getBook(id: string): BookRecord | undefined {
  return books.get(id);
}

export function addBook(input: CreateBookInput): BookRecord {
  const book = { id: randomUUID(), ...input };
  books.set(book.id, book);
  return book;
}

export function updateBook(id: string, input: UpdateBookInput): BookRecord | undefined {
  const current = books.get(id);
  if (!current) {
    return undefined;
  }
  const updated = { ...current, ...input };
  books.set(id, updated);
  return updated;
}

export function removeBook(id: string): boolean {
  return books.delete(id);
}
