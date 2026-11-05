import { and, eq } from 'drizzle-orm';
import { hasInstanceAdminRole } from '../auth/roles.js';
import type { Database } from '../db/client.js';
import { domains, externalIdentities, mailboxes, user } from '../db/schema/index.js';

/**
 * The person an `(issuer, subject)` pair of an organization stands for, if
 * they may be reached that way now: they own an active person mailbox of the
 * organization on an active domain, are not banned, and are not an instance
 * administrator (checked at every resolution, not only when linking).
 */
export async function resolveExternalIdentity(
  db: Database,
  organizationId: string,
  issuer: string,
  subject: string,
): Promise<{ userId: string; address: string } | null> {
  const [row] = await db
    .select({
      userId: externalIdentities.userId,
      address: mailboxes.address,
      status: mailboxes.status,
      kind: mailboxes.kind,
      domainStatus: domains.status,
      role: user.role,
      banned: user.banned,
    })
    .from(externalIdentities)
    .innerJoin(user, eq(user.id, externalIdentities.userId))
    .innerJoin(mailboxes, and(eq(mailboxes.userId, externalIdentities.userId), eq(mailboxes.organizationId, organizationId)))
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(
      and(
        eq(externalIdentities.organizationId, organizationId),
        eq(externalIdentities.issuer, issuer),
        eq(externalIdentities.subject, subject),
      ),
    )
    .limit(1);
  if (!row || row.kind !== 'person' || row.status !== 'active' || row.domainStatus !== 'active') return null;
  if (row.banned || hasInstanceAdminRole(row.role)) return null;
  return { userId: row.userId, address: row.address };
}
