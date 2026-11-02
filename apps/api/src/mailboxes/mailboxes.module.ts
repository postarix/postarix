import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { AddressRegistry } from '../common/address-registry.js';
import { DomainsModule } from '../domains/domains.module.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { ArchivingController, ArchivingService } from './archiving.js';
import { MailboxCollectionsService } from './mailbox-collections.service.js';
import { MailboxesController } from './mailboxes.controller.js';
import { MailboxesRepository } from './mailboxes.repository.js';
import { MailboxesService } from './mailboxes.service.js';

@Module({
  imports: [AccountsModule, DomainsModule],
  controllers: [MailboxesController, ArchivingController],
  providers: [MailboxesRepository, MailboxesService, MailboxCollectionsService, ArchivingService, AddressRegistry, OrgAccessGuard],
  exports: [MailboxesRepository, MailboxesService, ArchivingService],
})
export class MailboxesModule {}
