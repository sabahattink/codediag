import { db } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ params }) => {
	await db.user.delete({ where: { id: params.id } });
	return new Response(null, { status: 204 });
};
