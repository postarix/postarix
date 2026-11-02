import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { AddressRegistry } from '../common/address-registry.js';
import { DomainsModule } from '../domains/domains.module.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { MailboxesController } from './mailboxes.controller.js';
import { MailboxesRepository } from './mailboxes.repository.js';
import { MailboxesService } from './mailboxes.service.js';

@Module({
  imports: [AccountsModule, DomainsModule],
  controllers: [MailboxesController],
  providers: [MailboxesRepository, MailboxesService, AddressRegistry, OrgAccessGuard],
  exports: [MailboxesRepository],
})
export class MailboxesModule {}
