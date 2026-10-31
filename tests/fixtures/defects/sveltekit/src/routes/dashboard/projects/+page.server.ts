import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import type { Actions } from './$types';

const archiveSchema = z.object({ id: z.string().uuid() });

// Protected by the handle hook, which guards every /dashboard route.
export const actions: Actions = {
	archive: async ({ request }) => {
		const parsed = archiveSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400);
		await db.project.update({ where: { id: parsed.data.id }, data: { archived: true } });
		return { archived: parsed.data.id };
	}
};
