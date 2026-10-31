import { createHmac, timingSafeEqual } from 'node:crypto';

/** Checks GitHub's X-Hub-Signature-256 header against the raw payload. */
export function verifySignature(payload: string, signature: string | null, secret: string): boolean {
	if (!secret || !signature?.startsWith('sha256=')) return false;
	const expected = Buffer.from(
		`sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`
	);
	const received = Buffer.from(signature);
	return expected.length === received.length && timingSafeEqual(expected, received);
}
