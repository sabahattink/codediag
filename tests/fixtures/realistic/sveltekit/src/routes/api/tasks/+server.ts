import { error, json } from '@sveltejs/kit';
import { newTaskSchema } from '$lib/schemas';
import { requireUser } from '$lib/server/auth';
import { createTask, listTasks } from '$lib/server/tasks';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	return json(await listTasks(user.id));
};

export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals);
	const parsed = newTaskSchema.safeParse(await request.json());
	if (!parsed.success) error(400, parsed.error.issues[0]?.message ?? 'Invalid task');

	return json(await createTask(user.id, parsed.data), { status: 201 });
};
