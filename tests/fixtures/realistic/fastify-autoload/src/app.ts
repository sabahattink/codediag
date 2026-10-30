import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AutoLoad, { type AutoloadPluginOptions } from '@fastify/autoload';
import type { FastifyPluginAsync, FastifyServerOptions } from 'fastify';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppOptions extends FastifyServerOptions, Partial<AutoloadPluginOptions> {}

export const options: AppOptions = {};

// fastify-cli loads this plugin. Shared plugins are loaded first so that the
// routes see their decorators and hooks.
const app: FastifyPluginAsync<AppOptions> = async (fastify, opts) => {
  fastify.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      message: statusCode < 500 ? error.message : 'Internal Server Error',
    });
  });

  await fastify.register(AutoLoad, {
    dir: join(__dirname, 'plugins'),
    options: { ...opts },
  });

  await fastify.register(AutoLoad, {
    dir: join(__dirname, 'routes'),
    autoHooks: true,
    cascadeHooks: true,
    options: { ...opts },
  });
};

export default app;
