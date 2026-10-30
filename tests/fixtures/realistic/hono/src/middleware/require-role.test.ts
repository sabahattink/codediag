import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { requireRole } from './require-role.js';

describe('requireRole', () => {
  it('forbids tokens without the role', async () => {
    const app = new Hono<{ Variables: { jwtPayload: { roles: string[] } } }>();
    app.use(async (c, next) => {
      c.set('jwtPayload', { roles: ['reader'] });
      await next();
    });
    app.get('/', requireRole('moderator'), (c) => c.text('ok'));

    const response = await app.request('/');
    expect(response.status).toBe(403);
  });
});
