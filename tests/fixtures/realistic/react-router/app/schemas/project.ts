import { z } from 'zod';

export const ProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
});

export const TaskSchema = z.object({
  title: z.string().trim().min(1).max(120),
});

export const ProjectIntentSchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal('add-task'), title: z.string().trim().min(1).max(120) }),
  z.object({ intent: z.literal('complete-task'), taskId: z.string().min(1) }),
  z.object({ intent: z.literal('delete-project') }),
]);

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  redirectTo: z.string().optional(),
});

export type NewProject = z.infer<typeof ProjectSchema>;
export type NewTask = z.infer<typeof TaskSchema>;
