import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organization } from './auth.js';

export const domainStatuses = ['pending', 'active', 'disabled'] as const;
export type DomainStatus = (typeof domainStatuses)[number];

/**
 * Mail domains. Tenant-scoped: every row belongs to exactly one organization.
 * A domain name is globally unique because mail routing must be unambiguous.
 */
export const domains = pgTable(
  'domains',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text().notNull().unique(),
    status: text({ enum: domainStatuses }).notNull().default('pending'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('domains_organization_id_idx').on(table.organizationId)],
);

export type DomainRow = typeof domains.$inferSelect;
