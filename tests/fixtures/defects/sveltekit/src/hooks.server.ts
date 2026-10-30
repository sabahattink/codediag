import { redirect, type Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { findUser } from '$lib/server/users';

const authenticate: Handle = async ({ event, resolve }) => {
	event.locals.user = await findUser(event.cookies.get('session'));
	return resolve(event);
};

// Guards the dashboard pages, but not the API under /api/admin.
const guardDashboard: Handle = async ({ event, resolve }) => {
	if (event.url.pathname.startsWith('/dashboard') && !event.locals.user) {
		redirect(303, '/login');
	}
	return resolve(event);
};

export const handle = sequence(authenticate, guardDashboard);
