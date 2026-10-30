import { describe, expect, it } from 'vitest';

const baseUrl = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

describe.skipIf(!process.env.E2E_BASE_URL)('health', () => {
  it('reports ok', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});
