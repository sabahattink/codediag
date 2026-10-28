import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import authPlugin from './plugins/auth.js';
import adminRoutes from './routes/admin.js';
import itemRoutes from './routes/items.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(helmet);
  await app.register(cors, { origin: ['https://shop.example.com'] });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(authPlugin);

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      message: statusCode < 500 ? error.message : 'Internal Server Error',
    });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  await app.register(itemRoutes, { prefix: '/items' });
  await app.register(adminRoutes, { prefix: '/admin' });

  return app;
}
