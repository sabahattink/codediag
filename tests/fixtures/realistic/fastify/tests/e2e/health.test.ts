import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';

describe('health', () => {
  it('responds', async () => {
    vi.stubEnv('JWT_SECRET', 'a-local-test-signing-key');
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
