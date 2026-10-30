import { json, redirect, type Handle } from '@sveltejs/kit';
import {
	deleteSessionCookie,
	SESSION_COOKIE,
	setSessionCookie,
	validateSessionToken
} from './auth';

/** API routes that callers reach without a session. */
const PUBLIC_API = ['/api/health', '/api/webhooks'];

/** Loads the session from its cookie and refreshes the cookie's expiry. */
export const authenticate: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE);
	if (!token) {
		event.locals.user = null;
		event.locals.session = null;
		return resolve(event);
	}

	const { session, user } = await validateSessionToken(token);
	if (session) {
		setSessionCookie(event, token, session.expiresAt);
	} else {
		deleteSessionCookie(event);
	}
	event.locals.user = user;
	event.locals.session = session;
	return resolve(event);
};

/** Sends anonymous visitors of the app to the login page and rejects anonymous API calls. */
export const guardRoutes: Handle = async ({ event, resolve }) => {
	if (event.locals.user) return resolve(event);

	if (event.route.id?.startsWith('/(app)')) {
		redirect(303, `/login?from=${encodeURIComponent(event.url.pathname)}`);
	}

	const { pathname } = event.url;
	if (pathname.startsWith('/api') && !PUBLIC_API.some((prefix) => pathname.startsWith(prefix))) {
		return json({ message: 'Unauthorized' }, { status: 401 });
	}
	return resolve(event);
};
