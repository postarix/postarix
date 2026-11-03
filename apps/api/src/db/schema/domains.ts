import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organization } from './auth.js';
import { relayHosts } from './routing.js';

export const domainStatuses = ['pending', 'active', 'disabled'] as const;
export type DomainStatus = (typeof domainStatuses)[number];

/** Periods of a sending rate limit, in seconds. */
export const ratePeriods = { second: 1, minute: 60, hour: 3600, day: 86400 } as const;
export type RatePeriod = keyof typeof ratePeriods;
const ratePeriodNames = Object.keys(ratePeriods) as [RatePeriod, ...RatePeriod[]];

/**
 * Mail domains. Tenant-scoped: every row belongs to exactly one organization.
 *
 * Ownership is proven by publishing `verificationToken` in a DNS TXT record
 * (verification lands in Phase 1). Until then a domain is `pending` and does
 * not block anyone else: several organizations may hold the same pending name,
 * so the API never reveals whether another tenant has claimed it. Only one
 * verified (non-pending) row per name may exist.
 */
export const domains = pgTable(
  'domains',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    status: text({ enum: domainStatuses }).notNull().default('pending'),
    verificationToken: text()
      .notNull()
      .$defaultFn(() => randomBytes(24).toString('base64url')),
    verifiedAt: timestamp({ withTimezone: true }),
    /**
     * An alias domain: every address of the target domain also exists here
     * (x@alias reaches x@target, and whoever may send as x@target may send
     * as x@alias). It has no mailboxes or aliases of its own.
     */
    aliasOfDomainId: uuid().references((): AnyPgColumn => domains.id, { onDelete: 'restrict' }),
    /** Free text for administrators. */
    description: text().notNull().default(''),
    /** Quota given to new mailboxes when none is chosen (null: unlimited). */
    defaultMailboxQuotaBytes: bigint({ mode: 'number' }),
    // Limits, set by instance administrators only (null: no limit).
    maxMailboxes: integer(),
    maxAliases: integer(),
    /** Largest quota one mailbox may have; with it set, no mailbox is unlimited. */
    maxMailboxQuotaBytes: bigint({ mode: 'number' }),
    /** Sum of the quotas of all the domain's mailboxes; with it set, no mailbox is unlimited. */
    totalQuotaBytes: bigint({ mode: 'number' }),
    /** Messages each of its mailboxes may send per period, unless the mailbox has its own limit. */
    rateLimit: integer(),
    ratePeriod: text({ enum: ratePeriodNames }),
    /** Send its mail through this smart host (set by instance administrators). */
    relayHostId: uuid().references(() => relayHosts.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('domains_organization_id_idx').on(table.organizationId),
    index('domains_alias_of_domain_id_idx').on(table.aliasOfDomainId),
    uniqueIndex('domains_organization_id_name_unique').on(table.organizationId, table.name),
    uniqueIndex('domains_name_verified_unique')
      .on(table.name)
      .where(sql`${table.status} <> 'pending'`),
    check(
      'domains_limits_valid',
      sql`(${table.maxMailboxes} IS NULL OR ${table.maxMailboxes} >= 0)
        AND (${table.maxAliases} IS NULL OR ${table.maxAliases} >= 0)
        AND (${table.defaultMailboxQuotaBytes} IS NULL OR ${table.defaultMailboxQuotaBytes} > 0)
        AND (${table.maxMailboxQuotaBytes} IS NULL OR ${table.maxMailboxQuotaBytes} > 0)
        AND (${table.totalQuotaBytes} IS NULL OR ${table.totalQuotaBytes} > 0)`,
    ),
    check(
      'domains_rate_limit_valid',
      sql`(${table.rateLimit} IS NULL) = (${table.ratePeriod} IS NULL) AND (${table.rateLimit} IS NULL OR ${table.rateLimit} > 0)`,
    ),
  ],
);

export type DomainRow = typeof domains.$inferSelect;

export const dkimKeyStatuses = ['active', 'retired'] as const;

/**
 * DKIM signing keys. Reached only through their domain, which is tenant-scoped.
 * Private keys are stored encrypted (see src/dkim/dkim-crypto.ts).
 */
export const dkimKeys = pgTable(
  'dkim_keys',
  {
    id: uuid().primaryKey().defaultRandom(),
    domainId: uuid()
      .notNull()
      .references(() => domains.id, { onDelete: 'cascade' }),
    selector: text().notNull(),
    publicKey: text().notNull(),
    privateKeyEncrypted: text().notNull(),
    status: text({ enum: dkimKeyStatuses }).notNull().default('active'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('dkim_keys_domain_id_selector_unique').on(table.domainId, table.selector),
    uniqueIndex('dkim_keys_one_active_per_domain')
      .on(table.domainId)
      .where(sql`${table.status} = 'active'`),
  ],
);

export type DkimKeyRow = typeof dkimKeys.$inferSelect;
