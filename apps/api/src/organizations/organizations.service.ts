import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { aliases, domains, mailboxes, member, organization, user } from '../db/schema/index.js';
import { highestRole, type OrgRole, orgRoles, type TenantContext } from '../tenancy/tenant-context.js';

export interface OrganizationSummaryDto {
  id: string;
  name: string;
  slug: string;
  role: OrgRole | null;
  counts: { domains: number; mailboxes: number; aliases: number; members: number };
  createdAt: string;
}

export interface MemberDto {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: OrgRole;
  createdAt: string;
}

export const addMemberSchema = z.strictObject({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  role: z.enum(orgRoles).default('member'),
});
export const updateMemberSchema = z.strictObject({ role: z.enum(orgRoles) });

/** Organization overviews and membership management. */
@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async counts(organizationIds: string[]) {
    const result = new Map<string, OrganizationSummaryDto['counts']>();
    for (const id of organizationIds) result.set(id, { domains: 0, mailboxes: 0, aliases: 0, members: 0 });
    if (organizationIds.length === 0) return result;
    const ids = sql`(${sql.join(organizationIds.map((id) => sql`${id}`), sql`, `)})`;
    const tables = [
      ['domains', domains, domains.organizationId],
      ['mailboxes', mailboxes, mailboxes.organizationId],
      ['aliases', aliases, aliases.organizationId],
      ['members', member, member.organizationId],
    ] as const;
    for (const [key, table, column] of tables) {
      const rows = await this.db
        .select({ id: column, total: count() })
        .from(table)
        .where(sql`${column} in ${ids}`)
        .groupBy(column);
      for (const row of rows) result.get(row.id)![key] = row.total;
    }
    return result;
  }

  /** Organizations the user belongs to, with their role in each. */
  async listForUser(userId: string): Promise<OrganizationSummaryDto[]> {
    const rows = await this.db
      .select({ org: organization, role: member.role })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(member.userId, userId))
      .orderBy(asc(organization.name));
    const counts = await this.counts(rows.map((r) => r.org.id));
    return rows.map(({ org, role }) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: highestRole(role),
      counts: counts.get(org.id)!,
      createdAt: org.createdAt.toISOString(),
    }));
  }

  /** Every organization on the instance (super-admins only; enforced by the controller guard). */
  async listAll(): Promise<OrganizationSummaryDto[]> {
    const rows = await this.db.select().from(organization).orderBy(asc(organization.name));
    const counts = await this.counts(rows.map((r) => r.id));
    return rows.map((org) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: null,
      counts: counts.get(org.id)!,
      createdAt: org.createdAt.toISOString(),
    }));
  }

  async overview(ctx: TenantContext): Promise<OrganizationSummaryDto & { viaSuperAdmin: boolean }> {
    const [org] = await this.db
      .select()
      .from(organization)
      .where(eq(organization.id, ctx.organizationId))
      .limit(1);
    if (!org) throw new NotFoundException();
    const counts = await this.counts([org.id]);
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: ctx.role,
      viaSuperAdmin: ctx.viaSuperAdmin,
      counts: counts.get(org.id)!,
      createdAt: org.createdAt.toISOString(),
    };
  }

  async listMembers(ctx: TenantContext): Promise<MemberDto[]> {
    const rows = await this.db
      .select({ member, email: user.email, name: user.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, ctx.organizationId))
      .orderBy(asc(user.email));
    return rows.map(({ member: m, email, name }) => ({
      id: m.id,
      userId: m.userId,
      email,
      name,
      role: highestRole(m.role) ?? 'member',
      createdAt: m.createdAt.toISOString(),
    }));
  }

  /** Adds an existing account to the organization. */
  async addMember(ctx: TenantContext, input: z.infer<typeof addMemberSchema>): Promise<MemberDto> {
    this.assertMayGrant(ctx, input.role);
    const [account] = await this.db
      .select({ id: user.id, email: user.email, name: user.name })
      .from(user)
      .where(eq(user.email, input.email))
      .limit(1);
    if (!account) {
      throw new UnprocessableEntityException({
        message: 'No account with this email exists. Create a mailbox for it first.',
        code: 'UNKNOWN_ACCOUNT',
      });
    }
    const [existing] = await this.db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, ctx.organizationId), eq(member.userId, account.id)))
      .limit(1);
    if (existing) throw new ConflictException('This account is already a member');

    const [row] = await this.db
      .insert(member)
      .values({
        id: crypto.randomUUID(),
        organizationId: ctx.organizationId,
        userId: account.id,
        role: input.role,
        createdAt: new Date(),
      })
      .returning();
    await this.audit.record(ctx, 'member.added', { type: 'member', id: row!.id, label: account.email }, { role: input.role });
    return { id: row!.id, userId: account.id, email: account.email, name: account.name, role: input.role, createdAt: row!.createdAt.toISOString() };
  }

  async updateMember(ctx: TenantContext, memberId: string, role: OrgRole): Promise<MemberDto> {
    const current = await this.requireMember(ctx, memberId);
    // Granting or revoking "owner" is reserved to owners.
    if (current.role === 'owner' || role === 'owner') this.assertMayGrant(ctx, 'owner');
    if (current.role === 'owner' && role !== 'owner') await this.assertNotLastOwner(ctx);

    await this.db
      .update(member)
      .set({ role })
      .where(and(eq(member.organizationId, ctx.organizationId), eq(member.id, memberId)));
    await this.audit.record(ctx, 'member.role_changed', { type: 'member', id: memberId, label: current.email }, { from: current.role, to: role });
    return { ...current, role };
  }

  async removeMember(ctx: TenantContext, memberId: string): Promise<void> {
    const current = await this.requireMember(ctx, memberId);
    if (current.role === 'owner') {
      this.assertMayGrant(ctx, 'owner');
      await this.assertNotLastOwner(ctx);
    }
    await this.db
      .delete(member)
      .where(and(eq(member.organizationId, ctx.organizationId), eq(member.id, memberId)));
    await this.audit.record(ctx, 'member.removed', { type: 'member', id: memberId, label: current.email });
  }

  private assertMayGrant(ctx: TenantContext, role: OrgRole): void {
    if (role === 'owner' && ctx.role !== 'owner') {
      throw new ForbiddenException('Only owners can grant or revoke the owner role');
    }
  }

  private async assertNotLastOwner(ctx: TenantContext): Promise<void> {
    const owners = (await this.listMembers(ctx)).filter((m) => m.role === 'owner');
    if (owners.length <= 1) throw new BadRequestException('An organization needs at least one owner');
  }

  private async requireMember(ctx: TenantContext, memberId: string): Promise<MemberDto> {
    const found = (await this.listMembers(ctx)).find((m) => m.id === memberId);
    if (!found) throw new NotFoundException('Member not found');
    return found;
  }
}
