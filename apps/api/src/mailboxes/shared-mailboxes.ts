import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Param,
  Post,
  Put,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { type MailboxAccess, type MailEngine, MailEngineError } from '@postarix/mail-engine';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { engineErrorToHttp } from '../common/engine-errors.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { Env } from '../config/env.js';
import { DATABASE, ENV, MAIL_ENGINE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import {
  type MailboxRow,
  mailboxes,
  organizationMailOptions,
  type SharedMailboxRight,
  sharedMailboxMembers,
  sharedMailboxRights,
  user,
} from '../db/schema/index.js';
import { requestDisconnect } from '../mail-sessions/session-disconnects.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';

export interface SharedMemberDto {
  userId: string;
  /** Their own mailbox in the organization. */
  address: string;
  displayName: string;
  rights: SharedMailboxRight;
  createdAt: string;
}

/** Everyone's shared mailboxes are checked against their members this often. */
const RECONCILE_MS = 60 * 60 * 1000;

/** The Cyrus access a member's rights give (sending is decided by Postarix, not Cyrus). */
function levelOf(rights: SharedMailboxRight): MailboxAccess['level'] {
  return rights === 'read' ? 'read' : 'readWrite';
}

/**
 * Members of shared mailboxes. PostgreSQL holds them; Cyrus gets them as ACLs
 * on every mail folder of the shared mailbox (MailEngine.setMailboxAccess),
 * set after each change and reconciled every hour. Whoever loses access is
 * signed out of their open mail sessions.
 */
@Injectable()
export class SharedMailboxesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SharedMailboxesService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(MAIL_ENGINE) private readonly engine: MailEngine,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async shared(ctx: TenantContext, mailboxId: string): Promise<MailboxRow> {
    const [row] = await this.db
      .select()
      .from(mailboxes)
      .where(and(eq(mailboxes.organizationId, ctx.organizationId), eq(mailboxes.id, mailboxId)))
      .limit(1);
    if (!row) throw new NotFoundException('Mailbox not found');
    if (row.kind !== 'shared') throw new UnprocessableEntityException('Only shared mailboxes have members');
    return row;
  }

  /** Members with their own mailbox's address (in the shared mailbox's organization). */
  private async memberRows(mailbox: Pick<MailboxRow, 'id' | 'organizationId'>) {
    return this.db
      .select({
        userId: sharedMailboxMembers.userId,
        rights: sharedMailboxMembers.rights,
        createdAt: sharedMailboxMembers.createdAt,
        address: mailboxes.address,
        displayName: mailboxes.displayName,
      })
      .from(sharedMailboxMembers)
      .innerJoin(
        mailboxes,
        and(eq(mailboxes.userId, sharedMailboxMembers.userId), eq(mailboxes.organizationId, mailbox.organizationId), eq(mailboxes.kind, 'person')),
      )
      .where(eq(sharedMailboxMembers.mailboxId, mailbox.id))
      .orderBy(asc(mailboxes.address));
  }

  async members(ctx: TenantContext, mailboxId: string): Promise<SharedMemberDto[]> {
    const mailbox = await this.shared(ctx, mailboxId);
    return (await this.memberRows(mailbox)).map((m) => ({ ...m, createdAt: m.createdAt.toISOString() }));
  }

  /** Adds a person of the organization (who owns a mailbox in it), or changes their rights. */
  async setMember(ctx: TenantContext, mailboxId: string, userId: string, rights: SharedMailboxRight): Promise<SharedMemberDto[]> {
    const mailbox = await this.shared(ctx, mailboxId);
    const [person] = await this.db
      .select({ address: mailboxes.address })
      .from(mailboxes)
      .where(and(eq(mailboxes.organizationId, ctx.organizationId), eq(mailboxes.userId, userId), eq(mailboxes.kind, 'person')))
      .limit(1);
    if (!person) throw new NotFoundException('There is no person with a mailbox here with that id');
    await this.db
      .insert(sharedMailboxMembers)
      .values({ mailboxId, userId, rights })
      .onConflictDoUpdate({ target: [sharedMailboxMembers.mailboxId, sharedMailboxMembers.userId], set: { rights } });
    await this.apply(mailbox);
    await this.audit.record(ctx, 'shared_mailbox.member_set', { type: 'mailbox', id: mailbox.id, label: mailbox.address }, { member: person.address, rights });
    return this.members(ctx, mailboxId);
  }

  async removeMember(ctx: TenantContext, mailboxId: string, userId: string): Promise<void> {
    const mailbox = await this.shared(ctx, mailboxId);
    const [removed] = await this.db
      .delete(sharedMailboxMembers)
      .where(and(eq(sharedMailboxMembers.mailboxId, mailboxId), eq(sharedMailboxMembers.userId, userId)))
      .returning();
    if (!removed) throw new NotFoundException('Not a member');
    const [person] = await this.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
    await this.apply(mailbox, [userId]);
    await this.audit.record(ctx, 'shared_mailbox.member_removed', { type: 'mailbox', id: mailbox.id, label: mailbox.address }, { member: person?.email ?? userId });
  }

  /** Re-applies one shared mailbox's members to the mail server (on demand from the admin panel). */
  async reconcile(ctx: TenantContext, mailboxId: string): Promise<{ reduced: string[] }> {
    return this.apply(await this.shared(ctx, mailboxId));
  }

  /**
   * Sets the shared mailbox's ACLs from its members, and ends the open
   * sessions of whoever lost access (Cyrus checks rights per session only
   * partly: a folder already selected stays readable). `alsoSignOut`: users
   * whose membership just went away (their address may no longer appear).
   */
  async apply(mailbox: Pick<MailboxRow, 'id' | 'organizationId' | 'address' | 'sharedSeen'>, alsoSignOut: string[] = []): Promise<{ reduced: string[] }> {
    const members = await this.memberRows(mailbox);
    let reduced: string[];
    try {
      ({ reduced } = await this.engine.setMailboxAccess(mailbox.address, {
        access: members.map((m) => ({ grantee: m.address, level: levelOf(m.rights) })),
        sharedSeen: mailbox.sharedSeen,
      }));
    } catch (error) {
      throw engineErrorToHttp(error);
    }
    if (reduced.length > 0 || alsoSignOut.length > 0) {
      await requestDisconnect(this.db, { addresses: reduced, userIds: alsoSignOut }, 'access_removed');
    }
    return { reduced };
  }

  /** Shared mailboxes a person belongs to (before they are deleted: their access must be taken away). */
  async membershipsOf(userId: string): Promise<Pick<MailboxRow, 'id' | 'organizationId' | 'address' | 'sharedSeen'>[]> {
    return this.db
      .select({ id: mailboxes.id, organizationId: mailboxes.organizationId, address: mailboxes.address, sharedSeen: mailboxes.sharedSeen })
      .from(sharedMailboxMembers)
      .innerJoin(mailboxes, eq(mailboxes.id, sharedMailboxMembers.mailboxId))
      .where(eq(sharedMailboxMembers.userId, userId));
  }

  /** The members' sessions end when a shared mailbox is disabled or deleted. */
  async signOutMembers(mailboxId: string): Promise<void> {
    const rows = await this.db.select({ userId: sharedMailboxMembers.userId }).from(sharedMailboxMembers).where(eq(sharedMailboxMembers.mailboxId, mailboxId));
    await requestDisconnect(this.db, { userIds: rows.map((r) => r.userId) }, 'access_removed');
  }

  /** Every shared mailbox's ACLs from PostgreSQL; what changed is logged. */
  async reconcileAll(): Promise<void> {
    const shared = await this.db
      .select({ id: mailboxes.id, organizationId: mailboxes.organizationId, address: mailboxes.address, sharedSeen: mailboxes.sharedSeen })
      .from(mailboxes)
      .where(and(eq(mailboxes.kind, 'shared'), inArray(mailboxes.status, ['active', 'no_login'])));
    for (const mailbox of shared) {
      try {
        const { reduced } = await this.apply(mailbox);
        if (reduced.length > 0) this.logger.warn(`Took away access to ${mailbox.address} the mail server still gave: ${reduced.join(', ')}`);
      } catch (error) {
        if (error instanceof MailEngineError && error.code === 'not_found') continue;
        this.logger.warn(`Could not check the members of ${mailbox.address}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  onApplicationBootstrap(): void {
    if (this.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.reconcileAll().catch(() => undefined), RECONCILE_MS);
    this.timer.unref();
    setTimeout(() => void this.reconcileAll().catch(() => undefined), 30_000).unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async mailOptions(ctx: TenantContext): Promise<{ sharedSenderHeader: boolean }> {
    const [row] = await this.db.select().from(organizationMailOptions).where(eq(organizationMailOptions.organizationId, ctx.organizationId));
    return { sharedSenderHeader: row?.sharedSenderHeader ?? false };
  }

  async setMailOptions(ctx: TenantContext, input: { sharedSenderHeader: boolean }): Promise<{ sharedSenderHeader: boolean }> {
    await this.db
      .insert(organizationMailOptions)
      .values({ organizationId: ctx.organizationId, ...input })
      .onConflictDoUpdate({ target: organizationMailOptions.organizationId, set: input });
    await this.audit.record(ctx, 'organization.mail_options_changed', { type: 'organization', id: ctx.organizationId, label: ctx.organizationId }, input);
    return this.mailOptions(ctx);
  }
}

const memberBody = z.strictObject({ rights: z.enum(sharedMailboxRights) });
const userIdPipe = new ZodValidationPipe(z.string().min(1).max(100));
const mailboxIdPipe = new ZodValidationPipe(z.uuid());

/** A shared mailbox's members: the organization's owners and administrators (or an API key limited to it). */
@Controller('orgs/:orgId/mailboxes/:mailboxId')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class SharedMailboxMembersController {
  constructor(@Inject(SharedMailboxesService) private readonly shared: SharedMailboxesService) {}

  @Get('members')
  async list(@Tenant() ctx: TenantContext, @Param('mailboxId', mailboxIdPipe) mailboxId: string) {
    return { data: await this.shared.members(ctx, mailboxId) };
  }

  @Put('members/:userId')
  async set(
    @Tenant() ctx: TenantContext,
    @Param('mailboxId', mailboxIdPipe) mailboxId: string,
    @Param('userId', userIdPipe) userId: string,
    @Body(new ZodValidationPipe(memberBody)) body: z.infer<typeof memberBody>,
  ) {
    return { data: await this.shared.setMember(ctx, mailboxId, userId, body.rights) };
  }

  @Delete('members/:userId')
  @HttpCode(204)
  async remove(@Tenant() ctx: TenantContext, @Param('mailboxId', mailboxIdPipe) mailboxId: string, @Param('userId', userIdPipe) userId: string): Promise<void> {
    await this.shared.removeMember(ctx, mailboxId, userId);
  }

  @Post('access/reconcile')
  @HttpCode(200)
  reconcile(@Tenant() ctx: TenantContext, @Param('mailboxId', mailboxIdPipe) mailboxId: string) {
    return this.shared.reconcile(ctx, mailboxId);
  }
}

const mailOptionsBody = z.strictObject({ sharedSenderHeader: z.boolean() });

/** An organization's mail options (who sent from a shared mailbox, in a "Sender:" header). */
@Controller('orgs/:orgId/mail-options')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class OrganizationMailOptionsController {
  constructor(@Inject(SharedMailboxesService) private readonly shared: SharedMailboxesService) {}

  @Get()
  get(@Tenant() ctx: TenantContext) {
    return this.shared.mailOptions(ctx);
  }

  @Put()
  set(@Tenant() ctx: TenantContext, @Body(new ZodValidationPipe(mailOptionsBody)) body: z.infer<typeof mailOptionsBody>) {
    return this.shared.setMailOptions(ctx, body);
  }
}
