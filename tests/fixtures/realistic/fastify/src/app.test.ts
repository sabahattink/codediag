import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';

describe('app', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('refuses to start without a signing key', async () => {
    vi.stubEnv('JWT_SECRET', '');
    await expect(buildApp()).rejects.toThrow('JWT_SECRET is not configured');
  });
});
