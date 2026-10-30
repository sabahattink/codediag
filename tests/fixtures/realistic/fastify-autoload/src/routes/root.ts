import type { FastifyPluginAsync } from 'fastify';

const root: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => ({ service: 'notes-api' }));
};

export default root;
