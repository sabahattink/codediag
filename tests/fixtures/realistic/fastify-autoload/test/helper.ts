import Fastify, { type FastifyInstance } from 'fastify';
import app from '../src/app.js';

export async function build(): Promise<FastifyInstance> {
  const fastify = Fastify();
  await fastify.register(app);
  await fastify.ready();
  return fastify;
}
