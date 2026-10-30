import { fail, redirect } from '@sveltejs/kit';
import { deleteSessionCookie, invalidateSession } from '$lib/server/auth';
import type { Actions } from './$types';

export const actions: Actions = {
	default: async (event) => {
		if (!event.locals.session) return fail(401);
		await invalidateSession(event.locals.session.id);
		deleteSessionCookie(event);
		redirect(303, '/login');
	}
};
