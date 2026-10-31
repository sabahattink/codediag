import { describe, expect, it } from 'vitest';
import { loginSchema, newTaskSchema, taskIdSchema, taskUpdateSchema } from './schemas';

describe('newTaskSchema', () => {
	it('trims titles and defaults notes', () => {
		expect(newTaskSchema.parse({ title: '  Ship it ' })).toEqual({ title: 'Ship it', notes: '' });
	});

	it('rejects empty titles', () => {
		expect(newTaskSchema.safeParse({ title: '   ' }).success).toBe(false);
	});
});

describe('taskUpdateSchema', () => {
	it('accepts partial updates', () => {
		expect(taskUpdateSchema.parse({ done: true })).toEqual({ done: true });
	});
});

describe('taskIdSchema', () => {
	it('requires a uuid', () => {
		expect(taskIdSchema.safeParse({ id: '42' }).success).toBe(false);
	});
});

describe('loginSchema', () => {
	it('requires an email address', () => {
		const credentials = { email: 'ada', password: 'x'.repeat(12) };
		expect(loginSchema.safeParse(credentials).success).toBe(false);
	});
});
