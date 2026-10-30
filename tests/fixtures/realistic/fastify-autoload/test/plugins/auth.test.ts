import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from '../helper.js';

describe('auth plugin', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('refuses to start without a signing key', async () => {
    vi.stubEnv('JWT_SECRET', '');
    await expect(build()).rejects.toThrow('JWT_SECRET is not configured');
  });
});
