import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { jwt } from 'hono/jwt';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { rateLimiter } from 'hono-rate-limiter';
import type { Config } from './config.js';
import books from './routes/books.js';
import reviews from './routes/reviews.js';

export function createApp(config: Config): Hono {
  const app = new Hono();

  app.use(logger());
  app.use(secureHeaders());
  app.use(
    '/api/*',
    rateLimiter({
      windowMs: 15 * 60 * 1000,
      limit: 300,
      keyGenerator: (c) => c.req.header('x-forwarded-for') ?? 'anonymous',
    }),
  );
  app.use('/api/*', cors({ origin: config.allowedOrigins }));

  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Hono runs middleware in registration order: everything mounted below
  // under /api requires a valid token.
  app.use('/api/*', jwt({ secret: config.jwtSecret, alg: 'HS256' }));
  app.route('/api/books', books);
  app.route('/api/reviews', reviews);

  app.notFound((c) => c.json({ message: 'Not Found' }, 404));
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return error.getResponse();
    }
    console.error(error);
    return c.json({ message: 'Internal Server Error' }, 500);
  });

  return app;
}
