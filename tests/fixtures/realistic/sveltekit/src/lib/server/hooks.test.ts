import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { guardRoutes } from './hooks';

vi.mock('./auth', () => ({}));

function eventFor(pathname: string, routeId: string | null, signedIn = false) {
	return {
		url: new URL(`http://localhost${pathname}`),
		route: { id: routeId },
		locals: { user: signedIn ? { id: 'u1', email: 'ada@example.com', name: 'Ada' } : null }
	} as unknown as RequestEvent;
}

const resolve = vi.fn(async () => new Response('ok'));

describe('guardRoutes', () => {
	it('redirects anonymous visitors of the app to the login page', async () => {
		await expect(
			guardRoutes({ event: eventFor('/tasks', '/(app)/tasks'), resolve })
		).rejects.toMatchObject({ status: 303 });
	});

	it('rejects anonymous API calls', async () => {
		const response = await guardRoutes({ event: eventFor('/api/tasks', '/api/tasks'), resolve });
		expect(response.status).toBe(401);
	});

	it('lets the health check and webhooks through', async () => {
		for (const path of ['/api/health', '/api/webhooks/github']) {
			const response = await guardRoutes({ event: eventFor(path, path), resolve });
			expect(response.status).toBe(200);
		}
	});

	it('lets signed-in users through', async () => {
		const response = await guardRoutes({ event: eventFor('/tasks', '/(app)/tasks', true), resolve });
		expect(response.status).toBe(200);
	});
});
