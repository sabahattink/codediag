import { describe, expect, it } from 'vitest';
import { addItem, listItems, removeItem } from './items.js';

describe('items service', () => {
  it('adds and removes items', () => {
    const item = addItem({ name: 'washer', quantity: 10 });
    expect(listItems()).toContainEqual(item);
    expect(removeItem(item.id)).toBe(true);
  });
});
