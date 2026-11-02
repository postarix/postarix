import { Body, ConflictException, Controller, Get, Inject, Injectable, NotFoundException, Put, UseGuards } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { organizationArchiving } from '../db/schema/index.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';
import { MailboxesRepository } from './mailboxes.repository.js';

export const archivingSchema = z.strictObject({
  /** The mailbox that receives a copy of all mail; null turns archiving off. */
  archiveMailboxId: z.uuid().nullable(),
  legalHold: z.boolean(),
});
export type ArchivingDto = z.infer<typeof archivingSchema>;

/**
 * Archiving (journaling) and legal hold of an organization. Postfix copies
 * every message the organization's addresses receive or send into the
 * archive mailbox (mail.archive_copies). Under legal hold, no mailbox of the
 * organization can be deleted or disabled, nor the organization itself.
 */
@Injectable()
export class ArchivingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(MailboxesRepository) private readonly mailboxes: MailboxesRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async get(ctx: TenantContext): Promise<ArchivingDto> {
    const [row] = await this.db
      .select({ archiveMailboxId: organizationArchiving.archiveMailboxId, legalHold: organizationArchiving.legalHold })
      .from(organizationArchiving)
      .where(eq(organizationArchiving.organizationId, ctx.organizationId))
      .limit(1);
    return { archiveMailboxId: row?.archiveMailboxId ?? null, legalHold: row?.legalHold ?? false };
  }

  async update(ctx: TenantContext, input: ArchivingDto): Promise<ArchivingDto> {
    if (input.archiveMailboxId) {
      const mailbox = await this.mailboxes.findById(ctx, input.archiveMailboxId);
      if (!mailbox) throw new NotFoundException('Mailbox not found');
      if (mailbox.status !== 'active') throw new ConflictException('The archive mailbox must be enabled');
    }
    const before = await this.get(ctx);
    if (before.legalHold && before.archiveMailboxId && input.archiveMailboxId !== before.archiveMailboxId && input.legalHold) {
      throw new ConflictException('Lift the legal hold before changing the archive mailbox');
    }
    await this.db
      .insert(organizationArchiving)
      .values({ organizationId: ctx.organizationId, ...input })
      .onConflictDoUpdate({ target: organizationArchiving.organizationId, set: input });
    if (before.archiveMailboxId !== input.archiveMailboxId) {
      await this.audit.record(ctx, input.archiveMailboxId ? 'organization.archiving_on' : 'organization.archiving_off', {
        type: 'organization',
        id: ctx.organizationId,
      }, { archiveMailboxId: input.archiveMailboxId });
    }
    if (before.legalHold !== input.legalHold) {
      await this.audit.record(ctx, input.legalHold ? 'organization.legal_hold_on' : 'organization.legal_hold_off', {
        type: 'organization',
        id: ctx.organizationId,
      });
    }
    return input;
  }

  /** Refuses removing (or disabling) a mailbox under legal hold, or the archive itself. */
  async assertMayRemove(ctx: TenantContext, mailboxId: string): Promise<void> {
    const settings = await this.get(ctx);
    if (settings.legalHold) throw new ConflictException({ message: 'The organization is under legal hold: mailboxes cannot be deleted or disabled', code: 'LEGAL_HOLD' });
    if (settings.archiveMailboxId === mailboxId) throw new ConflictException({ message: 'This is the organization’s archive mailbox: turn archiving off first', code: 'ARCHIVE_MAILBOX' });
  }

  /** Whether an organization is under legal hold (it cannot be deleted then). */
  async onHold(organizationId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ legalHold: organizationArchiving.legalHold })
      .from(organizationArchiving)
      .where(eq(organizationArchiving.organizationId, organizationId))
      .limit(1);
    return row?.legalHold ?? false;
  }
}

/** Archiving and legal hold: owners only (they can keep mail from being deleted, and read it all). */
@Controller('orgs/:orgId/archiving')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('owner')
export class ArchivingController {
  constructor(@Inject(ArchivingService) private readonly archiving: ArchivingService) {}

  @Get()
  get(@Tenant() ctx: TenantContext): Promise<ArchivingDto> {
    return this.archiving.get(ctx);
  }

  @Put()
  update(@Tenant() ctx: TenantContext, @Body(new ZodValidationPipe(archivingSchema)) body: ArchivingDto): Promise<ArchivingDto> {
    return this.archiving.update(ctx, body);
  }
}
