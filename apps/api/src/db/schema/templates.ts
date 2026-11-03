import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organization } from './auth.js';

export const templateKinds = ['domain', 'mailbox'] as const;
export type TemplateKind = (typeof templateKinds)[number];

/**
 * Settings given to new domains or mailboxes. Domain templates are
 * instance-wide (organizationId null, managed by instance administrators,
 * since they hold limits); mailbox templates belong to an organization. The
 * default one of each applies when no other is chosen. `settings` is checked
 * by src/templates/templates.ts.
 */
export const templates = pgTable(
  'templates',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text().references(() => organization.id, { onDelete: 'cascade' }),
    kind: text({ enum: templateKinds }).notNull(),
    name: text().notNull(),
    isDefault: boolean().notNull().default(false),
    settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('templates_organization_id_idx').on(table.organizationId),
    uniqueIndex('templates_name_unique').on(sql`coalesce(${table.organizationId}, '')`, table.kind, sql`lower(${table.name})`),
    uniqueIndex('templates_one_default')
      .on(sql`coalesce(${table.organizationId}, '')`, table.kind)
      .where(sql`${table.isDefault}`),
    check('templates_scope_valid', sql`(${table.kind} = 'domain') = (${table.organizationId} IS NULL)`),
  ],
);

export type TemplateRow = typeof templates.$inferSelect;
