import { db } from './db';

export async function findUser(sessionId: string | undefined) {
	if (!sessionId) return null;
	const session = await db.session.findUnique({ where: { id: sessionId }, include: { user: true } });
	return session?.user ?? null;
}
