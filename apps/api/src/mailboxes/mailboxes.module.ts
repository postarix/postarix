import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { AddressRegistry } from '../common/address-registry.js';
import { DomainsModule } from '../domains/domains.module.js';
import { RateLimitsModule } from '../rate-limits/rate-limits.module.js';
import { SpamModule } from '../spam/spam.js';
import { TemplatesModule } from '../templates/templates.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { ArchivingController, ArchivingService } from './archiving.js';
import { MailboxCollectionsService } from './mailbox-collections.service.js';
import { MailboxesController } from './mailboxes.controller.js';
import { MailboxesRepository } from './mailboxes.repository.js';
import { MailboxesService } from './mailboxes.service.js';
import { QuotaWarningsService } from './quota-warnings.js';
import { OrganizationMailOptionsController, SharedMailboxesService, SharedMailboxMembersController } from './shared-mailboxes.js';

@Module({
  imports: [AccountsModule, DomainsModule, RateLimitsModule, SpamModule, TemplatesModule],
  controllers: [MailboxesController, ArchivingController, SharedMailboxMembersController, OrganizationMailOptionsController],
  providers: [MailboxesRepository, MailboxesService, QuotaWarningsService, MailboxCollectionsService, ArchivingService, AddressRegistry, OrgAccessGuard, SharedMailboxesService],
  exports: [MailboxesRepository, MailboxesService, ArchivingService, SharedMailboxesService],
})
export class MailboxesModule {}
