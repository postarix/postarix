import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { type DomainRow, domains, ssoProvider } from '../db/schema/index.js';
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

  async create(ctx: TenantContext, name: string): Promise<DomainRow> {
    const [row] = await this.db
      .insert(domains)
      .values({ organizationId: ctx.organizationId, name })
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
