import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { verifySignature } from '$lib/server/github';
import { closeTasksForIssue } from '$lib/server/tasks';
import type { RequestHandler } from './$types';

const issueEvent = z.object({
	action: z.string(),
	issue: z.object({ html_url: z.string().url() })
});

/** GitHub calls this without a session, so the payload signature authenticates it. */
export const POST: RequestHandler = async ({ request }) => {
	const payload = await request.text();
	const signature = request.headers.get('x-hub-signature-256');
	if (!verifySignature(payload, signature, env.GITHUB_WEBHOOK_SECRET ?? '')) {
		error(401, 'Invalid signature');
	}

	const event = issueEvent.safeParse(JSON.parse(payload));
	if (!event.success) error(400, 'Unexpected payload');
	if (event.data.action === 'closed') await closeTasksForIssue(event.data.issue.html_url);
	return json({ received: true });
};
