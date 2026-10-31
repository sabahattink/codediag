import { error, fail } from '@sveltejs/kit';
import { superValidate } from 'sveltekit-superforms';
import { zod } from 'sveltekit-superforms/adapters';
import { newTaskSchema, taskIdSchema } from '$lib/schemas';
import { requireUser } from '$lib/server/auth';
import { createTask, deleteTask, listTasks, updateTask } from '$lib/server/tasks';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);
	return {
		tasks: await listTasks(user.id),
		form: await superValidate(zod(newTaskSchema))
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await superValidate(request, zod(newTaskSchema));
		if (!form.valid) return fail(400, { form });

		await createTask(user.id, form.data);
		return { form };
	},

	complete: async ({ request, locals }) => {
		const user = requireUser(locals);
		const parsed = taskIdSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Unknown task' });

		const task = await updateTask(user.id, parsed.data.id, { done: true });
		if (!task) error(404, 'Task not found');
		return { completed: task.id };
	},

	delete: async ({ request, locals }) => {
		const user = requireUser(locals);
		const parsed = taskIdSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Unknown task' });

		if (!(await deleteTask(user.id, parsed.data.id))) error(404, 'Task not found');
		return { deleted: parsed.data.id };
	}
};
