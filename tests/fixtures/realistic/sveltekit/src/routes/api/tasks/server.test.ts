import type { RequestEvent } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTask } from '$lib/server/tasks';
import { POST } from './+server';

vi.mock('$lib/server/tasks', () => ({
	createTask: vi.fn(async (ownerId: string, input: object) => ({ id: 't1', ownerId, ...input })),
	listTasks: vi.fn(async () => [])
}));

function post(body: unknown, signedIn = true) {
	return POST({
		request: new Request('http://localhost/api/tasks', {
			method: 'POST',
			body: JSON.stringify(body)
		}),
		locals: { user: signedIn ? { id: 'u1', email: 'ada@example.com', name: 'Ada' } : null }
	} as unknown as RequestEvent<Record<string, never>, '/api/tasks'>);
}

describe('POST /api/tasks', () => {
	beforeEach(() => vi.mocked(createTask).mockClear());

	it('creates a task for the signed-in user', async () => {
		const response = await post({ title: 'Write release notes' });
		expect(response.status).toBe(201);
		expect(createTask).toHaveBeenCalledWith('u1', { title: 'Write release notes', notes: '' });
	});

	it('rejects invalid tasks', async () => {
		await expect(post({ title: '' })).rejects.toMatchObject({ status: 400 });
		expect(createTask).not.toHaveBeenCalled();
	});

	it('rejects anonymous callers', async () => {
		await expect(post({ title: 'x' }, false)).rejects.toMatchObject({ status: 401 });
	});
});
