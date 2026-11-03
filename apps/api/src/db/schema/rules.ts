import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organization } from './auth.js';
import { domains } from './domains.js';

export const bccDirections = ['sender', 'recipient'] as const;
export type BccDirection = (typeof bccDirections)[number];

/**
 * Automatic blind copies: mail sent by (sender) or to (recipient) an address
 * or a whole domain of the organization is also delivered to `destination`.
 * Tenant-scoped; Postfix reads them through mail.bcc_targets.
 */
export const bccRules = pgTable(
  'bcc_rules',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    domainId: uuid()
      .notNull()
      .references(() => domains.id, { onDelete: 'cascade' }),
    /** An address of the domain, or "@domain" for all of them. */
    address: text().notNull(),
    direction: text({ enum: bccDirections }).notNull(),
    /** Any address, here or elsewhere. */
    destination: text().notNull(),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('bcc_rules_organization_id_idx').on(table.organizationId),
    uniqueIndex('bcc_rules_unique').on(table.address, table.direction, table.destination),
  ],
);

/**
 * Instance-wide recipient rewriting (first of Postfix virtual_alias_maps): mail
 * for `address` (an address, or "@domain") is delivered to `destination`
 * instead, wherever it came from. Managed by instance administrators.
 */
export const recipientMaps = pgTable(
  'recipient_maps',
  {
    id: uuid().primaryKey().defaultRandom(),
    address: text().notNull(),
    destination: text().notNull(),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('recipient_maps_address_unique').on(table.address)],
);

export type BccRuleRow = typeof bccRules.$inferSelect;
export type RecipientMapRow = typeof recipientMaps.$inferSelect;
