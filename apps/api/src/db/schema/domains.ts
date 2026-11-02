import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organization } from './auth.js';

export const domainStatuses = ['pending', 'active', 'disabled'] as const;
export type DomainStatus = (typeof domainStatuses)[number];

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
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('domains_organization_id_idx').on(table.organizationId),
    uniqueIndex('domains_organization_id_name_unique').on(table.organizationId, table.name),
    uniqueIndex('domains_name_verified_unique')
      .on(table.name)
      .where(sql`${table.status} <> 'pending'`),
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
