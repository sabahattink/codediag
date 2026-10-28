import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { CreateItem, Item, ItemParams } from '../schemas/item.js';
import { addItem, listItems, removeItem } from '../services/items.js';

const itemRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get('/', { schema: { response: { 200: Type.Array(Item) } } }, async () => listItems());

  fastify.post(
    '/',
    {
      onRequest: [fastify.authenticate],
      schema: { body: CreateItem, response: { 201: Item } },
    },
    async (request, reply) => reply.code(201).send(addItem(request.body)),
  );

  fastify.delete(
    '/:id',
    { onRequest: [fastify.authenticate], schema: { params: ItemParams } },
    async (request, reply) => {
      const removed = removeItem(request.params.id);
      return reply.code(removed ? 204 : 404).send();
    },
  );
};

export default itemRoutes;
