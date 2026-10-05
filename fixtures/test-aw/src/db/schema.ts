// Drizzle table definitions (drizzle-orm/pg-core). This file is the source of truth for the
// database schema: after changing it, run `npm run db:generate` to create a migration in drizzle/.
import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

/** Unique index that makes emails case-insensitively unique among active (non-deleted) users. */
export const USERS_EMAIL_ACTIVE_UNIQUE = 'users_email_active_unique';

/** Users. A row with `deletedAt` set is soft-deleted and treated as if it didn't exist. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stored exactly as sent; uniqueness is checked on lower(email). */
    email: text('email').notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** null = active. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex(USERS_EMAIL_ACTIVE_UNIQUE)
      .on(sql`lower(${table.email})`)
      .where(sql`${table.deletedAt} is null`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
