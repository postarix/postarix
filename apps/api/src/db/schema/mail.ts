import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization, user } from './auth.js';
import { domains } from './domains.js';

export const mailboxStatuses = ['active', 'disabled'] as const;
export type MailboxStatus = (typeof mailboxStatuses)[number];

/**
 * A mailbox stored in the mail engine. Each one belongs to a user account whose
 * email equals the mailbox address, so the same credentials work for webmail.
 */
export const mailboxes = pgTable(
  'mailboxes',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    domainId: uuid()
      .notNull()
      .references(() => domains.id, { onDelete: 'no action' }),
    userId: text().references(() => user.id, { onDelete: 'set null' }),
    localPart: text().notNull(),
    /** Full lowercase address, denormalized for lookups by Postfix and the auth bridge. */
    address: text().notNull().unique(),
    displayName: text().notNull().default(''),
    quotaBytes: bigint({ mode: 'number' }),
    status: text({ enum: mailboxStatuses }).notNull().default('active'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('mailboxes_organization_id_idx').on(table.organizationId),
    index('mailboxes_domain_id_idx').on(table.domainId),
    index('mailboxes_user_id_idx').on(table.userId),
    check('mailboxes_quota_positive', sql`${table.quotaBytes} IS NULL OR ${table.quotaBytes} > 0`),
  ],
);

/** Forwarding addresses. Destinations may be local mailboxes or external addresses. */
export const aliases = pgTable(
  'aliases',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    domainId: uuid()
      .notNull()
      .references(() => domains.id, { onDelete: 'no action' }),
    localPart: text().notNull(),
    address: text().notNull().unique(),
    destinations: text().array().notNull(),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('aliases_organization_id_idx').on(table.organizationId),
    check('aliases_destinations_not_empty', sql`cardinality(${table.destinations}) > 0`),
  ],
);

export const appPasswordScopes = ['imap', 'smtp', 'dav'] as const;
export type AppPasswordScope = (typeof appPasswordScopes)[number];

/** Per-device passwords for mail clients (IMAP, SMTP, CalDAV/CardDAV). */
export const appPasswords = pgTable(
  'app_passwords',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** First characters of the password, used to find candidates without scanning every hash. */
    lookupPrefix: text().notNull(),
    passwordHash: text().notNull(),
    scopes: text({ enum: appPasswordScopes }).array().notNull(),
    lastUsedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('app_passwords_user_id_idx').on(table.userId),
    uniqueIndex('app_passwords_user_id_name_unique').on(table.userId, table.name),
    index('app_passwords_lookup_idx').on(table.userId, table.lookupPrefix),
  ],
);

export type MailboxRow = typeof mailboxes.$inferSelect;
export type AliasRow = typeof aliases.$inferSelect;
export type AppPasswordRow = typeof appPasswords.$inferSelect;
