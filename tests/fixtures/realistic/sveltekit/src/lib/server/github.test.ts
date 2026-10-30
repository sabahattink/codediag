import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignature } from './github';

const secret = randomBytes(16).toString('hex');
const payload = JSON.stringify({ action: 'closed' });
const sign = (body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('verifySignature', () => {
	it('accepts the signature GitHub computes', () => {
		expect(verifySignature(payload, sign(payload), secret)).toBe(true);
	});

	it('rejects a signature for another payload', () => {
		expect(verifySignature(payload, sign('{}'), secret)).toBe(false);
	});

	it('rejects requests without a signature or secret', () => {
		expect(verifySignature(payload, null, secret)).toBe(false);
		expect(verifySignature(payload, sign(payload), '')).toBe(false);
	});
});
