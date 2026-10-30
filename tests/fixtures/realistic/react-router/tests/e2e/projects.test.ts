import { describe, expect, it } from 'vitest';

const baseUrl = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

describe.skipIf(!process.env.E2E_BASE_URL)('projects', () => {
  it('sends anonymous visitors to the login page', async () => {
    const response = await fetch(`${baseUrl}/projects`, { redirect: 'manual' });
    expect(response.headers.get('Location')).toBe('/login?redirectTo=%2Fprojects');
  });

  it('rejects anonymous API writes', async () => {
    const response = await fetch(`${baseUrl}/api/projects/p1/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Ship it' }),
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
  });
});
