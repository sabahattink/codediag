import { describe, expect, it, vi } from 'vitest';
import { generateSessionToken, requireUser } from './auth';

vi.mock('./db', () => ({ db: {} }));

describe('generateSessionToken', () => {
	it('creates distinct base32 tokens', () => {
		const first = generateSessionToken();
		expect(first).toMatch(/^[a-z2-7]{32}$/);
		expect(generateSessionToken()).not.toBe(first);
	});
});

describe('requireUser', () => {
	it('returns the signed-in user', () => {
		const user = { id: 'u1', email: 'ada@example.com', name: 'Ada' };
		expect(requireUser({ user, session: null })).toBe(user);
	});

	it('rejects anonymous callers with 401', () => {
		expect(() => requireUser({ user: null, session: null })).toThrow(
			expect.objectContaining({ status: 401 })
		);
	});
});
