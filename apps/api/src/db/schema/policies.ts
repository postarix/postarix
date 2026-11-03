import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Instance-wide mail policies, managed by instance administrators (see
 * src/policies). Postfix and Rspamd read them through mail.* views and
 * Valkey.
 */

/**
 * Servers that forward mail here (another provider's forwarding rule, a
 * gateway): never greylisted, and never refused as spam. With the spam filter
 * off for them, their mail is not scanned at all.
 */
export const forwardingHosts = pgTable(
  'forwarding_hosts',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** An address, a network (CIDR) or a host name (resolved regularly). */
    host: text().notNull(),
    spamFilter: boolean().notNull().default(true),
    enabled: boolean().notNull().default(true),
    note: text().notNull().default(''),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('forwarding_hosts_host_unique').on(table.host)],
);

export const ipAccessKinds = ['allow', 'block'] as const;

/**
 * Addresses and networks always refused (block) or never refused by the
 * client checks (allow) when they connect to send mail, and refused by the
 * API (sign-in, the admin panel, the webmail) when blocked. A block wins.
 */
export const ipAccess = pgTable(
  'ip_access',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** An address or network, in CIDR form ("203.0.113.0/24", "2001:db8::/32"). */
    network: text().notNull(),
    kind: text({ enum: ipAccessKinds }).notNull(),
    note: text().notNull().default(''),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('ip_access_network_kind_unique').on(table.network, table.kind)],
);

export const filterTargets = ['subject', 'from', 'to', 'header'] as const;
export const filterActions = ['reject', 'junk'] as const;

/**
 * Server-wide content rules (mailcow's regex maps): a regular expression on
 * the subject, the sender, the recipients or a header; matching mail is
 * refused or filed as junk. Rspamd applies them (POSTARIX_FILTER_RULES).
 */
export const filterRules = pgTable(
  'filter_rules',
  {
    id: uuid().primaryKey().defaultRandom(),
    target: text({ enum: filterTargets }).notNull(),
    /** The header's name, for target "header". */
    header: text(),
    /** A PCRE-style regular expression, matched case-insensitively. */
    pattern: text().notNull(),
    action: text({ enum: filterActions }).notNull(),
    note: text().notNull().default(''),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('filter_rules_enabled_idx').on(table.enabled)],
);

export type ForwardingHostRow = typeof forwardingHosts.$inferSelect;
export type IpAccessRow = typeof ipAccess.$inferSelect;
export type FilterRuleRow = typeof filterRules.$inferSelect;
