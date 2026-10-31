import { z } from 'zod';

export const newTaskSchema = z.object({
	title: z.string().trim().min(1).max(200),
	notes: z.string().max(2000).default(''),
	dueOn: z.coerce.date().optional()
});

export const taskUpdateSchema = newTaskSchema.partial().extend({
	done: z.boolean().optional()
});

export const taskIdSchema = z.object({ id: z.string().uuid() });

export const loginSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8)
});

export type NewTask = z.infer<typeof newTaskSchema>;
export type TaskUpdate = z.infer<typeof taskUpdateSchema>;
