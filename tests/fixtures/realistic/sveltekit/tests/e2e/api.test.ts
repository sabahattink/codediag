import { describe, expect, it } from 'vitest';

/** Runs against `npm run preview` when BASE_URL is set, as in CI. */
const baseUrl = process.env.BASE_URL;

describe.skipIf(!baseUrl)('deployed API', () => {
	it('reports healthy', async () => {
		const response = await fetch(`${baseUrl}/api/health`);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
	});

	it('rejects anonymous task requests', async () => {
		const response = await fetch(`${baseUrl}/api/tasks`, { method: 'POST', body: '{}' });
		expect(response.status).toBe(401);
	});
});
