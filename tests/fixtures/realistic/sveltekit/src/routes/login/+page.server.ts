import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { message, superValidate } from 'sveltekit-superforms';
import { zod } from 'sveltekit-superforms/adapters';
import { loginSchema } from '$lib/schemas';
import { createSession, generateSessionToken, setSessionCookie } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { verifyPassword } from '$lib/server/password';
import { users } from '$lib/server/schema';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) redirect(303, '/tasks');
	return { form: await superValidate(zod(loginSchema)) };
};

export const actions: Actions = {
	default: async (event) => {
		const form = await superValidate(event, zod(loginSchema));
		if (!form.valid) return fail(400, { form });

		const [user] = await db.select().from(users).where(eq(users.email, form.data.email));
		if (!user || !(await verifyPassword(user.passwordHash, form.data.password))) {
			return message(form, 'Incorrect email or password', { status: 400 });
		}

		const token = generateSessionToken();
		const session = await createSession(token, user.id);
		setSessionCookie(event, token, session.expiresAt);
		redirect(303, '/tasks');
	}
};
