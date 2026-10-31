import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

// Protects the admin pages, but form actions run before load functions.
export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user?.isAdmin) redirect(303, '/login');
	return { user: locals.user };
};
