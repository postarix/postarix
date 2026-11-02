import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { domains, mailboxes } from '../db/schema/index.js';

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
