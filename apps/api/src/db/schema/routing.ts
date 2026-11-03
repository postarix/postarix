import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Instance-wide outgoing mail routing, managed by instance administrators.
 *
 * Postfix reads the credentials in clear through the mail.* views (it must
 * send them to the relay): they are readable by the mail database role, like
 * the rest of the routing.
 */

/** Smart hosts a domain's or a mailbox's mail can be sent through (sender-dependent relayhost). */
export const relayHosts = pgTable('relay_hosts', {
  id: uuid().primaryKey().defaultRandom(),
  /** host, host:port, [host] or [host]:port, as Postfix expects ([…]: no MX lookup). */
  host: text().notNull(),
  username: text().notNull().default(''),
  password: text().notNull().default(''),
  enabled: boolean().notNull().default(true),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Where mail for a destination (a domain, ".domain" for its subdomains, or an address) is handed over. */
export const transportRoutes = pgTable(
  'transport_routes',
  {
    id: uuid().primaryKey().defaultRandom(),
    destination: text().notNull(),
    /** host, host:port, [host] or [host]:port. */
    nexthop: text().notNull(),
    username: text().notNull().default(''),
    password: text().notNull().default(''),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('transport_routes_destination_unique').on(table.destination)],
);

export const tlsPolicyLevels = ['none', 'may', 'encrypt', 'dane', 'dane-only', 'fingerprint', 'verify', 'secure'] as const;
export type TlsPolicyLevel = (typeof tlsPolicyLevels)[number];

/** How Postfix uses TLS towards a destination (smtp_tls_policy_maps). */
export const tlsPolicies = pgTable(
  'tls_policies',
  {
    id: uuid().primaryKey().defaultRandom(),
    destination: text().notNull(),
    policy: text({ enum: tlsPolicyLevels }).notNull(),
    /** Extra attributes, e.g. "protocols=>=TLSv1.2" or "match=…". */
    parameters: text().notNull().default(''),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('tls_policies_destination_unique').on(table.destination)],
);

export type RelayHostRow = typeof relayHosts.$inferSelect;
export type TransportRouteRow = typeof transportRoutes.$inferSelect;
export type TlsPolicyRow = typeof tlsPolicies.$inferSelect;
