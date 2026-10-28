import { type Static, Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

const Settings = Type.Object({ lowStockThreshold: Type.Integer({ minimum: 0 }) });

let settings: Static<typeof Settings> = { lowStockThreshold: 5 };

// Every route in this plugin requires a valid token.
export default async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/settings', async () => settings);

  fastify.put('/settings', { schema: { body: Settings } }, async (request) => {
    settings = request.body as Static<typeof Settings>;
    return settings;
  });
}
