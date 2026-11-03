import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, max } from 'drizzle-orm';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { type DomainRow, domains, mailboxes, session, ssoProvider } from '../db/schema/index.js';
import { type DomainUsage, domainUsage, lockDomain } from './domain-limits.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/**
 * Data access for domains. Every method takes the TenantContext first and
 * filters by its organization: there is deliberately no unscoped accessor.
 */
@Injectable()
export class DomainsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private scope(ctx: TenantContext) {
    return eq(domains.organizationId, ctx.organizationId);
  }

  list(ctx: TenantContext): Promise<DomainRow[]> {
    return this.db.select().from(domains).where(this.scope(ctx)).orderBy(asc(domains.name));
  }

  async findById(ctx: TenantContext, id: string): Promise<DomainRow | undefined> {
    const [row] = await this.db
      .select()
      .from(domains)
      .where(and(this.scope(ctx), eq(domains.id, id)))
      .limit(1);
    return row;
  }

  /** What the domain holds; undefined if it is not the organization's. */
  async usage(ctx: TenantContext, id: string): Promise<DomainUsage | undefined> {
    if (!(await this.findById(ctx, id))) return undefined;
    return domainUsage(this.db, id);
  }

  /**
   * Changes a domain while its row is locked, after `check` (which may throw)
   * has seen its current usage and largest mailbox quota.
   */
  async update(
    ctx: TenantContext,
    id: string,
    changes: Partial<
      Pick<
        DomainRow,
        | 'description'
        | 'status'
        | 'defaultMailboxQuotaBytes'
        | 'maxMailboxes'
        | 'maxAliases'
        | 'maxMailboxQuotaBytes'
        | 'totalQuotaBytes'
        | 'rateLimit'
        | 'ratePeriod'
        | 'relayHostId'
      >
    >,
    check: (domain: DomainRow, usage: DomainUsage, largestQuota: number | null) => void,
  ): Promise<DomainRow | undefined> {
    return this.db.transaction(async (tx) => {
      const locked = await lockDomain(tx, ctx, id);
      if (!locked) return undefined;
      const [largest] = await tx
        .select({ q: max(mailboxes.quotaBytes) })
        .from(mailboxes)
        .where(eq(mailboxes.domainId, id));
      check(locked.domain, locked.usage, largest?.q ?? null);
      const [row] = await tx
        .update(domains)
        .set(changes)
        .where(and(this.scope(ctx), eq(domains.id, id)))
        .returning();
      return row;
    });
  }

  /** Ends the web sessions of the domain's mailboxes. */
  async signOutMailboxes(ctx: TenantContext, id: string): Promise<void> {
    const owners = this.db
      .select({ userId: mailboxes.userId })
      .from(mailboxes)
      .where(and(eq(mailboxes.organizationId, ctx.organizationId), eq(mailboxes.domainId, id)));
    await this.db.delete(session).where(inArray(session.userId, owners));
  }

  async create(ctx: TenantContext, name: string, aliasOfDomainId: string | null = null): Promise<DomainRow> {
    const [row] = await this.db
      .insert(domains)
      .values({ organizationId: ctx.organizationId, name, aliasOfDomainId })
      .returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async activate(ctx: TenantContext, id: string): Promise<DomainRow | undefined> {
    const [row] = await this.db
      .update(domains)
      .set({ status: 'active', verifiedAt: new Date() })
      .where(and(this.scope(ctx), eq(domains.id, id)))
      .returning();
    return row;
  }

  /**
   * Deletes the domain together with the organization's single sign-on
   * provider for it: sign-in finds providers by domain, so a provider left
   * behind would capture the domain's sign-ins after another organization
   * verifies it.
   */
  async delete(ctx: TenantContext, id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(domains)
        .where(and(this.scope(ctx), eq(domains.id, id)))
        .returning({ id: domains.id, name: domains.name });
      const row = deleted[0];
      if (!row) return false;
      await tx
        .delete(ssoProvider)
        .where(and(eq(ssoProvider.organizationId, ctx.organizationId), eq(ssoProvider.domain, row.name)));
      return true;
    });
  }
}
