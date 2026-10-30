import { beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from '../helper.js';

describe('notes', () => {
  beforeEach(() => vi.stubEnv('JWT_SECRET', 'a-local-test-signing-key'));

  it('rejects unauthenticated reads', async () => {
    const app = await build();
    const response = await app.inject({ method: 'GET', url: '/notes' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects unauthenticated archiving', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'PUT',
      url: '/notes/archive/0b6b1f9e-3f57-4d4e-9a52-6a1c0d3c1f00',
      payload: { archived: true },
    });
    expect(response.statusCode).toBe(401);
  });

  it('reports health without a token', async () => {
    const app = await build();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
