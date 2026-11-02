import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
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
      .references(() => organization.id, { onDelete: 'restrict' }),
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
      .references(() => organization.id, { onDelete: 'restrict' }),
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

/**
 * Audit trail of administrative actions. Organization-scoped events carry the
 * organization ID; instance-level events (e.g. creating organizations) leave it null.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text().references(() => organization.id, { onDelete: 'cascade' }),
    actorUserId: text().references(() => user.id, { onDelete: 'set null' }),
    /** Snapshot of the actor's email, kept after the user is deleted. */
    actorEmail: text(),
    action: text().notNull(),
    targetType: text().notNull(),
    targetId: text(),
    /** Human-readable label of the target at the time (e.g. the address). */
    targetLabel: text(),
    details: jsonb().$type<Record<string, unknown>>(),
    ipAddress: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_events_org_created_idx').on(table.organizationId, table.createdAt, table.id)],
);

export type AuditEventRow = typeof auditEvents.$inferSelect;

/**
 * A person's mail labels. Applied to messages as JMAP keywords (IMAP flags),
 * so they live on the messages themselves; this table only names them.
 */
export const mailLabels = pgTable(
  'mail_labels',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** The keyword set on labelled messages ("label-" + a slug of the name). */
    keyword: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('mail_labels_user_keyword_unique').on(table.userId, table.keyword)],
);
