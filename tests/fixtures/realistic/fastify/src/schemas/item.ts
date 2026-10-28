import { type Static, Type } from '@sinclair/typebox';

export const Item = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  quantity: Type.Integer({ minimum: 0 }),
});

export const CreateItem = Type.Omit(Item, ['id']);
export const ItemParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

export type ItemRecord = Static<typeof Item>;
export type CreateItemInput = Static<typeof CreateItem>;
