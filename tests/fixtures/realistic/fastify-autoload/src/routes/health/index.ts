import type { FastifyPluginAsync } from 'fastify';

const health: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => ({ status: 'ok' }));
};

export default health;
