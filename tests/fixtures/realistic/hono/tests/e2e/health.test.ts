import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';

const signingKey = 'local-test-signing-key'.padEnd(32, '-');

describe('health', () => {
  it('responds without a token', async () => {
    const app = createApp({ port: 0, jwtSecret: signingKey, allowedOrigins: [] });
    const response = await app.request('/health');
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});
