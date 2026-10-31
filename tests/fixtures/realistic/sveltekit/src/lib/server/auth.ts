import { error, type RequestEvent } from '@sveltejs/kit';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeBase32LowerCaseNoPadding, encodeHexLowerCase } from '@oslojs/encoding';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { sessions, users } from './schema';

const DAY_IN_MS = 1000 * 60 * 60 * 24;
export const SESSION_COOKIE = 'auth-session';

export type Session = typeof sessions.$inferSelect;
export type User = Pick<typeof users.$inferSelect, 'id' | 'email' | 'name'>;

export function generateSessionToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	return encodeBase32LowerCaseNoPadding(bytes);
}

function sessionId(token: string): string {
	return encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
}

export async function createSession(token: string, userId: string): Promise<Session> {
	const session: Session = {
		id: sessionId(token),
		userId,
		expiresAt: new Date(Date.now() + DAY_IN_MS * 30)
	};
	await db.insert(sessions).values(session);
	return session;
}

export async function validateSessionToken(token: string) {
	const [result] = await db
		.select({ user: { id: users.id, email: users.email, name: users.name }, session: sessions })
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(eq(sessions.id, sessionId(token)));
	if (!result) return { session: null, user: null };

	const { session, user } = result;
	if (Date.now() >= session.expiresAt.getTime()) {
		await invalidateSession(session.id);
		return { session: null, user: null };
	}
	if (Date.now() >= session.expiresAt.getTime() - DAY_IN_MS * 15) {
		session.expiresAt = new Date(Date.now() + DAY_IN_MS * 30);
		await db
			.update(sessions)
			.set({ expiresAt: session.expiresAt })
			.where(eq(sessions.id, session.id));
	}
	return { session, user };
}

export async function invalidateSession(id: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.id, id));
}

export function setSessionCookie(event: RequestEvent, token: string, expiresAt: Date): void {
	event.cookies.set(SESSION_COOKIE, token, { expires: expiresAt, path: '/' });
}

export function deleteSessionCookie(event: RequestEvent): void {
	event.cookies.delete(SESSION_COOKIE, { path: '/' });
}

/** The signed-in user, for actions and endpoints that need their id. */
export function requireUser(locals: App.Locals): User {
	if (!locals.user) error(401, 'Sign in to continue');
	return locals.user;
}
