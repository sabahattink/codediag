import { boolean, date, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('user', {
	id: text('id').primaryKey(),
	email: text('email').notNull().unique(),
	name: text('name').notNull(),
	passwordHash: text('password_hash').notNull()
});

export const sessions = pgTable('session', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull()
});

export const tasks = pgTable('task', {
	id: uuid('id').primaryKey().defaultRandom(),
	ownerId: text('owner_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	notes: text('notes').notNull().default(''),
	dueOn: date('due_on', { mode: 'date' }),
	issueUrl: text('issue_url'),
	done: boolean('done').notNull().default(false),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
