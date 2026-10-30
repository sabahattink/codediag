import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => json(await db.post.findMany());

// Authenticated, but the body goes to the database as sent.
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Sign in first');
	const body = await request.json();
	return json(await db.post.create({ data: { ...body, authorId: locals.user.id } }), { status: 201 });
};
