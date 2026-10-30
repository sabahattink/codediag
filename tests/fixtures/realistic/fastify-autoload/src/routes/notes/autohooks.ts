import type { FastifyPluginAsync } from 'fastify';

// Every route under /notes, including nested directories, requires a token.
const hooks: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', fastify.authenticate);
};

export default hooks;
