import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { domains, mailboxes } from '../db/schema/index.js';

export interface Resource {
  email: string;
  name: string;
  kind: 'room' | 'equipment';
}

export interface OwnMailbox {
  address: string;
  organizationId: string;
}

/**
 * Mailboxes in the signed-in person's organization: the only people they may
 * see the free/busy of and share calendars and contacts with.
 */
@Injectable()
export class ColleaguesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The person's own active mailbox and its organization. */
  async own(userId: string): Promise<OwnMailbox | null> {
    const [row] = await this.db
      .select({ address: mailboxes.address, organizationId: mailboxes.organizationId })
      .from(mailboxes)
      .innerJoin(domains, eq(domains.id, mailboxes.domainId))
      .where(and(eq(mailboxes.userId, userId), eq(mailboxes.status, 'active'), eq(domains.status, 'active')))
      .limit(1);
    return row ?? null;
  }

  /** Which of `addresses` are active mailboxes of the organization (lowercase). */
  async inOrganization(organizationId: string, addresses: string[]): Promise<Set<string>> {
    const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))];
    if (wanted.length === 0) return new Set();
    const rows = await this.db
      .select({ address: mailboxes.address })
      .from(mailboxes)
      .innerJoin(domains, eq(domains.id, mailboxes.domainId))
      .where(
        and(
          eq(mailboxes.organizationId, organizationId),
          inArray(mailboxes.address, wanted),
          eq(mailboxes.status, 'active'),
          eq(domains.status, 'active'),
        ),
      );
    return new Set(rows.map((r) => r.address));
  }

  /** The organization's rooms and equipment that can be booked. */
  async resources(organizationId: string, addresses?: string[]): Promise<Resource[]> {
    if (addresses && addresses.length === 0) return [];
    const rows = await this.db
      .select({ email: mailboxes.address, name: mailboxes.displayName, kind: mailboxes.kind })
      .from(mailboxes)
      .innerJoin(domains, eq(domains.id, mailboxes.domainId))
      .where(
        and(
          eq(mailboxes.organizationId, organizationId),
          ne(mailboxes.kind, 'person'),
          eq(mailboxes.status, 'active'),
          eq(domains.status, 'active'),
          ...(addresses ? [inArray(mailboxes.address, addresses.map((a) => a.toLowerCase()))] : []),
        ),
      )
      .orderBy(asc(mailboxes.displayName), asc(mailboxes.address));
    return rows.map((r) => ({ email: r.email, name: r.name || r.email, kind: r.kind as Resource['kind'] }));
  }
}
