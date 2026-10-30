import { and, desc, eq } from 'drizzle-orm';
import type { NewTask, TaskUpdate } from '$lib/schemas';
import { db } from './db';
import { tasks } from './schema';

export function listTasks(ownerId: string) {
	return db.select().from(tasks).where(eq(tasks.ownerId, ownerId)).orderBy(desc(tasks.createdAt));
}

export async function createTask(ownerId: string, input: NewTask) {
	const [task] = await db
		.insert(tasks)
		.values({ ...input, ownerId })
		.returning();
	return task;
}

export async function updateTask(ownerId: string, id: string, changes: TaskUpdate) {
	const [task] = await db
		.update(tasks)
		.set(changes)
		.where(and(eq(tasks.id, id), eq(tasks.ownerId, ownerId)))
		.returning();
	return task ?? null;
}

export async function deleteTask(ownerId: string, id: string): Promise<boolean> {
	const deleted = await db
		.delete(tasks)
		.where(and(eq(tasks.id, id), eq(tasks.ownerId, ownerId)))
		.returning({ id: tasks.id });
	return deleted.length > 0;
}

/** Marks the tasks linked to a GitHub issue as done when the issue closes. */
export async function closeTasksForIssue(issueUrl: string): Promise<void> {
	await db.update(tasks).set({ done: true }).where(eq(tasks.issueUrl, issueUrl));
}
