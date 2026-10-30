import { RouterContextProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

const getUser = vi.fn();
vi.mock('~/session.server', () => ({
  getUser,
  loginRedirect: () => new Response(null, { status: 302, headers: { Location: '/login' } }),
}));

const { requireUserMiddleware } = await import('./auth.server');

function run(request: Request) {
  return requireUserMiddleware(
    { request, context: new RouterContextProvider(), params: {}, unstable_pattern: '' },
    async () => new Response('ok'),
  );
}

describe('requireUserMiddleware', () => {
  it('redirects anonymous requests', async () => {
    getUser.mockResolvedValueOnce(null);
    await expect(run(new Request('http://localhost/projects'))).rejects.toBeInstanceOf(Response);
  });

  it('lets signed-in users through', async () => {
    getUser.mockResolvedValueOnce({ id: 'u1', email: 'ada@example.com', name: 'Ada' });
    await expect(run(new Request('http://localhost/projects'))).resolves.toBeUndefined();
  });
});
