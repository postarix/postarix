import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { aliases, type AliasRow, type DomainRow } from '../db/schema/index.js';
import { type DomainUsage, lockDomain } from '../domains/domain-limits.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/** Tenant-scoped data access for aliases. */
@Injectable()
export class AliasesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private scope(ctx: TenantContext) {
    return eq(aliases.organizationId, ctx.organizationId);
  }

  list(ctx: TenantContext): Promise<AliasRow[]> {
    return this.db.select().from(aliases).where(this.scope(ctx)).orderBy(asc(aliases.address));
  }

  async findById(ctx: TenantContext, id: string): Promise<AliasRow | undefined> {
    const [row] = await this.db
      .select()
      .from(aliases)
      .where(and(this.scope(ctx), eq(aliases.id, id)))
      .limit(1);
    return row;
  }

  async create(
    ctx: TenantContext,
    input: Pick<AliasRow, 'domainId' | 'localPart' | 'address' | 'destinations' | 'enabled'>,
    check: (domain: DomainRow, usage: DomainUsage) => void,
  ): Promise<AliasRow> {
    return this.db.transaction(async (tx) => {
      const locked = await lockDomain(tx, ctx, input.domainId);
      if (!locked) throw new Error('Domain not found');
      check(locked.domain, locked.usage);
      const [row] = await tx
        .insert(aliases)
        .values({ ...input, organizationId: ctx.organizationId })
        .returning();
      if (!row) throw new Error('Insert returned no row');
      return row;
    });
  }

  async update(
    ctx: TenantContext,
    id: string,
    changes: Partial<Pick<AliasRow, 'destinations' | 'enabled'>>,
  ): Promise<AliasRow | undefined> {
    const [row] = await this.db
      .update(aliases)
      .set(changes)
      .where(and(this.scope(ctx), eq(aliases.id, id)))
      .returning();
    return row;
  }

  async delete(ctx: TenantContext, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(aliases)
      .where(and(this.scope(ctx), eq(aliases.id, id)))
      .returning({ id: aliases.id });
    return deleted.length > 0;
  }
}
