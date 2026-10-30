import { describe, expect, it, vi } from 'vitest';

vi.mock('./env.server', () => ({
  env: { NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(32) },
}));
vi.mock('./db.server', () => ({ db: { user: { findUnique: vi.fn() } } }));

const { loginRedirect, requireUserId } = await import('./session.server');

describe('requireUserId', () => {
  it('redirects anonymous requests to the login page', async () => {
    const request = new Request('http://localhost/projects/abc');
    await expect(requireUserId(request)).rejects.toBeInstanceOf(Response);
  });

  it('keeps the requested path for after login', () => {
    const response = loginRedirect(new Request('http://localhost/projects/abc'));
    expect(response.headers.get('Location')).toBe('/login?redirectTo=%2Fprojects%2Fabc');
  });
});
