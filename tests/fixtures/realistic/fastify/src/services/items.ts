import { randomUUID } from 'node:crypto';
import type { CreateItemInput, ItemRecord } from '../schemas/item.js';

const items = new Map<string, ItemRecord>();

export function listItems(): ItemRecord[] {
  return [...items.values()];
}

export function addItem(input: CreateItemInput): ItemRecord {
  const item = { id: randomUUID(), ...input };
  items.set(item.id, item);
  return item;
}

export function removeItem(id: string): boolean {
  return items.delete(id);
}
