import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';

describe('items', () => {
  beforeEach(() => vi.stubEnv('JWT_SECRET', 'a-local-test-signing-key'));

  it('rejects unauthenticated writes', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/items',
      payload: { name: 'bolt', quantity: 3 },
    });
    expect(response.statusCode).toBe(401);
  });
});
