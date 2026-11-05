import { and, asc, eq, ne } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { alias } from 'drizzle-orm/pg-core';
import { domains, mailboxes, type SharedMailboxRight, sharedMailboxMembers } from '../db/schema/index.js';

/**
 * The signed-in user's own mailbox address, or null. A lookup by user ID (the
 * caller's own data), not by organization: the webmail is personal.
 */
export async function findOwnMailbox(db: Database, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ address: mailboxes.address })
    .from(mailboxes)
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(and(eq(mailboxes.userId, userId), eq(mailboxes.status, 'active'), eq(domains.status, 'active')))
    .limit(1);
  return row?.address ?? null;
}

export interface SharedAccount {
  id: string;
  organizationId: string;
  /** The shared mailbox's address: its JMAP account id and its mail login in Cyrus. */
  address: string;
  displayName: string;
  rights: SharedMailboxRight;
}

/**
 * The shared mailboxes a person may use now: they are a member, the shared
 * mailbox is not disabled and its domain is active, and the person's own
 * mailbox (in the same organization) is active.
 */
export async function findSharedAccounts(db: Database, userId: string): Promise<SharedAccount[]> {
  const own = alias(mailboxes, 'own');
  const ownDomain = alias(domains, 'own_domain');
  return db
    .select({
      id: mailboxes.id,
      organizationId: mailboxes.organizationId,
      address: mailboxes.address,
      displayName: mailboxes.displayName,
      rights: sharedMailboxMembers.rights,
    })
    .from(sharedMailboxMembers)
    .innerJoin(mailboxes, and(eq(mailboxes.id, sharedMailboxMembers.mailboxId), eq(mailboxes.kind, 'shared')))
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .innerJoin(own, and(eq(own.userId, sharedMailboxMembers.userId), eq(own.organizationId, mailboxes.organizationId), eq(own.kind, 'person')))
    .innerJoin(ownDomain, eq(ownDomain.id, own.domainId))
    .where(
      and(
        eq(sharedMailboxMembers.userId, userId),
        ne(mailboxes.status, 'disabled'),
        eq(domains.status, 'active'),
        eq(own.status, 'active'),
        eq(ownDomain.status, 'active'),
      ),
    )
    .orderBy(asc(mailboxes.address));
}

/**
 * The person's mail login and the account to act on: their own, or a shared
 * mailbox they may use now (`accountId`). Null when they have no mailbox or
 * the account is not theirs to reach.
 */
export async function resolveMailAccount(
  db: Database,
  userId: string,
  accountId?: string,
): Promise<{ login: string; account: string; shared: SharedAccount | null } | null> {
  const login = await findOwnMailbox(db, userId);
  if (!login) return null;
  if (accountId === undefined || accountId === login) return { login, account: login, shared: null };
  const shared = (await findSharedAccounts(db, userId)).find((s) => s.address === accountId);
  return shared ? { login, account: shared.address, shared } : null;
}
