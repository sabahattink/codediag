import { db } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({ users: await db.user.findMany() });

export const actions: Actions = {
	delete: async ({ request }) => {
		const data = await request.formData();
		await db.user.delete({ where: { id: String(data.get('id')) } });
		return { deleted: true };
	}
};
