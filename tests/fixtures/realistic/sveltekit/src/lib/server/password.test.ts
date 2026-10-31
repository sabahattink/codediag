import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
	it('verifies the password a hash was made from', async () => {
		const stored = await hashPassword('correct horse battery');
		await expect(verifyPassword(stored, 'correct horse battery')).resolves.toBe(true);
	});

	it('rejects other passwords', async () => {
		const stored = await hashPassword('correct horse battery');
		await expect(verifyPassword(stored, 'wrong horse battery')).resolves.toBe(false);
	});
});
