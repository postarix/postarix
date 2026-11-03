import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization, session, user } from './auth.js';
import { domains, type RatePeriod, ratePeriods } from './domains.js';
import { relayHosts } from './routing.js';

/** active; no_login: receives mail but nobody can sign in; disabled: neither. */
export const mailboxStatuses = ['active', 'no_login', 'disabled'] as const;
export type MailboxStatus = (typeof mailboxStatuses)[number];

/** People's mailboxes, or bookable resources: their calendar answers invitations by itself. */
export const mailboxKinds = ['person', 'room', 'equipment'] as const;
export type MailboxKind = (typeof mailboxKinds)[number];

/** Mail protocols a mailbox may sign in with (the webmail is always allowed). */
export const mailProtocols = ['imap', 'pop3', 'smtp', 'sieve', 'dav'] as const;
export type MailProtocol = (typeof mailProtocols)[number];

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
    kind: text({ enum: mailboxKinds }).notNull().default('person'),
    allowedProtocols: text({ enum: mailProtocols })
      .array()
      .notNull()
      .default(sql`ARRAY['imap','pop3','smtp','sieve','dav']::text[]`),
    /** Refuse mail for it from servers that do not use TLS. */
    tlsRequiredIn: boolean().notNull().default(false),
    /** Its outgoing mail is only handed to servers over TLS (otherwise it waits, then bounces). */
    tlsRequiredOut: boolean().notNull().default(false),
    /** Messages it may send per period; null: its domain's limit, if any. */
    rateLimit: integer(),
    ratePeriod: text({ enum: Object.keys(ratePeriods) as [RatePeriod, ...RatePeriod[]] }),
    /** Send its mail through this smart host instead of its domain's (set by instance administrators). */
    relayHostId: uuid().references(() => relayHosts.id, { onDelete: 'set null' }),
    /** Cyrus Murder: the backend the mailbox lives on (null: the default one). */
    mailServer: text(),
    /** When its calendars and address books were made private (see MailboxCollectionsService). */
    collectionsRestrictedAt: timestamp({ withTimezone: true }),
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
    check(
      'mailboxes_rate_limit_valid',
      sql`(${table.rateLimit} IS NULL) = (${table.ratePeriod} IS NULL) AND (${table.rateLimit} IS NULL OR ${table.rateLimit} > 0)`,
    ),
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
    /** Empty for a catch-all ("@domain": every address of the domain that is not a mailbox or alias). */
    localPart: text().notNull(),
    address: text().notNull().unique(),
    destinations: text().array().notNull(),
    enabled: boolean().notNull().default(true),
    /** Accept the mail and drop it, whatever the destinations (e.g. an old address that only gets spam). */
    discard: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('aliases_organization_id_idx').on(table.organizationId),
    check('aliases_destinations_not_empty', sql`cardinality(${table.destinations}) > 0 OR ${table.discard}`),
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

/**
 * Further addresses a mailbox may send as, besides itself and the aliases
 * that deliver to it: one address, or "@domain" for every address of the
 * domain. Only addresses on the organization's own domains.
 */
export const mailboxSendAs = pgTable(
  'mailbox_send_as',
  {
    mailboxId: uuid()
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    domainId: uuid()
      .notNull()
      .references(() => domains.id, { onDelete: 'cascade' }),
    sender: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('mailbox_send_as_unique').on(table.mailboxId, table.sender),
    index('mailbox_send_as_sender_idx').on(table.sender),
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

/**
 * Security rules an organization sets for its people. One row per
 * organization; no row means the defaults (nothing required).
 */
export const organizationSecurity = pgTable('organization_security', {
  organizationId: text()
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  /** Every member and mailbox owner must sign in with a second factor (an authenticator app or a passkey). */
  requireSecondFactor: boolean().notNull().default(false),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Web sessions opened with more than a password: a passkey, a second factor
 * (authenticator app, backup code) or the organization's identity provider.
 * Organizations that require a second factor accept only these (and sessions
 * of accounts whose password sign-in always asks for one).
 */
export const sessionFactors = pgTable('session_factors', {
  sessionId: text()
    .primaryKey()
    .references(() => session.id, { onDelete: 'cascade' }),
  method: text({ enum: ['passkey', 'two_factor', 'sso'] }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const mailImportStatuses = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type MailImportStatus = (typeof mailImportStatuses)[number];

/**
 * Copying a person's mail from another provider (any IMAP server: Gmail,
 * Fastmail, an old server…) into their mailbox. The source password is kept
 * encrypted with AUTH_SECRET while the import runs and erased when it ends.
 */
export const mailImports = pgTable(
  'mail_imports',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** The mailbox the mail goes into (the person's own). */
    mailboxAddress: text().notNull(),
    host: text().notNull(),
    port: bigint({ mode: 'number' }).notNull(),
    security: text({ enum: ['tls', 'starttls'] }).notNull(),
    username: text().notNull(),
    /** Encrypted; null once the import has ended. */
    password: text(),
    status: text({ enum: mailImportStatuses }).notNull().default('queued'),
    /** Per source folder: UIDVALIDITY and the highest UID copied, so an interrupted import resumes. */
    progress: jsonb().$type<Record<string, { uidValidity: string; lastUid: number }>>().notNull().default({}),
    imported: bigint({ mode: 'number' }).notNull().default(0),
    skipped: bigint({ mode: 'number' }).notNull().default(0),
    error: text(),
    /** Set while a worker runs it; a stale lock (crashed worker) lets another one resume. */
    lockedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (table) => [index('mail_imports_user_id_idx').on(table.userId), index('mail_imports_status_idx').on(table.status)],
);

/**
 * Archiving (journaling) for an organization: a copy of every message its
 * mailboxes receive or send goes to an archive mailbox of the organization,
 * which people cannot change from their own mail. Under legal hold, mailboxes
 * and the archive cannot be deleted.
 */
export const organizationArchiving = pgTable('organization_archiving', {
  organizationId: text()
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  /** The mailbox that receives the copies; null: archiving off. */
  archiveMailboxId: uuid().references(() => mailboxes.id, { onDelete: 'restrict' }),
  legalHold: boolean().notNull().default(false),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
