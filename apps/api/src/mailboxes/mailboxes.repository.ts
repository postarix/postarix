import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { mailboxes, type MailboxRow, member } from '../db/schema/index.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

export interface NewMailbox {
  domainId: string;
  userId: string;
  localPart: string;
  address: string;
  displayName: string;
  quotaBytes: number | null;
}

/** Tenant-scoped data access for mailboxes. */
@Injectable()
export class MailboxesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private scope(ctx: TenantContext) {
    return eq(mailboxes.organizationId, ctx.organizationId);
  }

  list(ctx: TenantContext): Promise<MailboxRow[]> {
    return this.db.select().from(mailboxes).where(this.scope(ctx)).orderBy(asc(mailboxes.address));
  }

  async findById(ctx: TenantContext, id: string): Promise<MailboxRow | undefined> {
    const [row] = await this.db
      .select()
      .from(mailboxes)
      .where(and(this.scope(ctx), eq(mailboxes.id, id)))
      .limit(1);
    return row;
  }

  /** Inserts the mailbox and makes its user a member of the organization, atomically. */
  async create(ctx: TenantContext, input: NewMailbox): Promise<MailboxRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(mailboxes)
        .values({ ...input, organizationId: ctx.organizationId })
        .returning();
      if (!row) throw new Error('Insert returned no row');
      await tx
        .insert(member)
        .values({
          id: crypto.randomUUID(),
          organizationId: ctx.organizationId,
          userId: input.userId,
          role: 'member',
          createdAt: new Date(),
        })
        .onConflictDoNothing();
      return row;
    });
  }

  async update(
    ctx: TenantContext,
    id: string,
    changes: Partial<Pick<MailboxRow, 'displayName' | 'quotaBytes' | 'status'>>,
  ): Promise<MailboxRow | undefined> {
    const [row] = await this.db
      .update(mailboxes)
      .set(changes)
      .where(and(this.scope(ctx), eq(mailboxes.id, id)))
      .returning();
    return row;
  }

  async delete(ctx: TenantContext, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(mailboxes)
      .where(and(this.scope(ctx), eq(mailboxes.id, id)))
      .returning({ id: mailboxes.id });
    return deleted.length > 0;
  }
}
