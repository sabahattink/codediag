import type { HandleServerError } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { authenticate, guardRoutes } from '$lib/server/hooks';

export const handle = sequence(authenticate, guardRoutes);

export const handleError: HandleServerError = ({ error, event, status, message }) => {
	if (status >= 500) {
		console.error(`${event.request.method} ${event.url.pathname} failed`, error);
	}
	return { message };
};
