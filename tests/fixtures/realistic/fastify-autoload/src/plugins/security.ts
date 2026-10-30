import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fp from 'fastify-plugin';

export default fp(async (fastify) => {
  await fastify.register(helmet);
  await fastify.register(cors, { origin: ['https://notes.example.com'] });
  await fastify.register(rateLimit, { max: 100, timeWindow: '1 minute' });
});
