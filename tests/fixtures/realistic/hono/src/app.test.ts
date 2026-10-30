import { sign } from 'hono/jwt';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

const signingKey = 'local-test-signing-key'.padEnd(32, '-');
const app = createApp({ port: 0, jwtSecret: signingKey, allowedOrigins: [] });

describe('app', () => {
  it('rejects API requests without a token', async () => {
    const response = await app.request('/api/books');
    expect(response.status).toBe(401);
  });

  it('accepts API requests with a valid token', async () => {
    const token = await sign({ sub: 'reader-1', roles: ['reader'] }, signingKey, 'HS256');
    const response = await app.request('/api/books', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  it('answers unknown paths with JSON', async () => {
    const response = await app.request('/missing');
    expect(await response.json()).toEqual({ message: 'Not Found' });
  });
});
