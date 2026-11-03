import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AliasesService } from '../aliases/aliases.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthSession } from '../auth/session.js';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { member, organization, organizationArchiving } from '../db/schema/index.js';
import { DomainsService } from '../domains/domains.service.js';
import { ArchivingService } from '../mailboxes/archiving.js';
import { MailboxesService } from '../mailboxes/mailboxes.service.js';
import { SsoService } from '../sso/sso.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

export const confirmDeletionSchema = z.strictObject({ confirm: z.string().min(1).max(200) });

export interface DeletionReport {
  aliases: number;
  mailboxes: number;
  domains: number;
}

/**
 * Deletes an organization and everything it provisioned: sign-in providers,
 * aliases, mailboxes
 * (their mail on the mail server and their accounts), domains (and their DKIM
 * keys), then the organization itself. Each step goes through the same
 * services as a manual deletion, so nothing is left behind on the mail server
 * or in Valkey. A failure midway leaves the rest in place; running it again
 * picks up where it stopped.
 */
@Injectable()
export class OrganizationDeletionService {
  private readonly logger = new Logger(OrganizationDeletionService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AliasesService) private readonly aliases: AliasesService,
    @Inject(MailboxesService) private readonly mailboxes: MailboxesService,
    @Inject(DomainsService) private readonly domains: DomainsService,
    @Inject(SsoService) private readonly sso: SsoService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ArchivingService) private readonly archiving: ArchivingService,
  ) {}

  async delete(actor: AuthSession, organizationId: string, confirmName: string, ipAddress: string | null): Promise<DeletionReport> {
    const [org] = await this.db
      .select({ id: organization.id, name: organization.name })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    if (!org) throw new NotFoundException('Organization not found');
    if (confirmName !== org.name) {
      throw new BadRequestException('Type the organization name exactly to confirm the deletion');
    }

    const ctx: TenantContext = {
      organizationId: org.id,
      userId: actor.user.id,
      userEmail: actor.user.email,
      ipAddress,
      role: 'owner',
      viaSuperAdmin: true,
      instanceAdmin: true,
    };
    // Deleting a mailbox deletes its account; an account that administers the
    // instance is never removed as a side effect.
    const admins = await this.mailboxes.instanceAdminAddresses(ctx);
    if (admins.length > 0) {
      throw new ConflictException(
        `These mailboxes belong to instance administrators; remove their administrator role or move them first: ${admins.join(', ')}`,
      );
    }
    if (await this.archiving.onHold(org.id)) {
      throw new ConflictException('The organization is under legal hold; its owners must lift it before it can be deleted');
    }
    // Archiving stops first: the archive mailbox is deleted with the others.
    await this.db.delete(organizationArchiving).where(eq(organizationArchiving.organizationId, org.id));
    const report: DeletionReport = { aliases: 0, mailboxes: 0, domains: 0 };
    // Members first, so the organization's admins cannot provision anything
    // while it is being taken apart, then sign-in providers, so nobody signs in.
    await this.db.delete(member).where(eq(member.organizationId, org.id));
    await this.sso.removeAll(ctx);
    // Twice: a request that was already running when the members went may
    // still have added something.
    for (let pass = 0; pass < 2; pass++) {
      for (const alias of await this.aliases.list(ctx)) {
        await this.aliases.remove(ctx, alias.id);
        report.aliases++;
      }
      for (const mailbox of await this.mailboxes.list(ctx)) {
        await this.mailboxes.remove(ctx, mailbox.id);
        report.mailboxes++;
      }
    }
    for (const domain of await this.domains.list(ctx)) {
      await this.domains.remove(ctx, domain.id);
      report.domains++;
    }
    // Members, invitations and the organization's audit log go with it.
    await this.db.delete(organization).where(eq(organization.id, org.id));
    this.logger.log(`Organization ${org.name} (${org.id}) deleted by ${actor.user.email}`);
    await this.audit.recordInstance(
      { userId: actor.user.id, userEmail: actor.user.email, ipAddress },
      'organization.deleted',
      { type: 'organization', id: org.id, label: org.name },
      { ...report },
    );
    return report;
  }
}
