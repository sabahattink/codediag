import { error, json } from '@sveltejs/kit';
import { taskUpdateSchema } from '$lib/schemas';
import { requireUser } from '$lib/server/auth';
import { deleteTask, updateTask } from '$lib/server/tasks';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals);
	const parsed = taskUpdateSchema.safeParse(await request.json());
	if (!parsed.success) error(400, parsed.error.issues[0]?.message ?? 'Invalid task');

	const task = await updateTask(user.id, params.id, parsed.data);
	if (!task) error(404, 'Task not found');
	return json(task);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const user = requireUser(locals);
	if (!(await deleteTask(user.id, params.id))) error(404, 'Task not found');
	return new Response(null, { status: 204 });
};
