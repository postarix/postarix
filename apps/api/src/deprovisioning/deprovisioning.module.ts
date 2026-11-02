import { Module } from '@nestjs/common';
import { AliasesModule } from '../aliases/aliases.module.js';
import { SuperAdminGuard } from '../auth/super-admin.guard.js';
import { DomainsModule } from '../domains/domains.module.js';
import { MailboxesModule } from '../mailboxes/mailboxes.module.js';
import { SsoModule } from '../sso/sso.module.js';
import { OrganizationDeletionController } from './organization-deletion.controller.js';
import { OrganizationDeletionService } from './organization-deletion.service.js';

@Module({
  imports: [AliasesModule, MailboxesModule, DomainsModule, SsoModule],
  controllers: [OrganizationDeletionController],
  providers: [OrganizationDeletionService, SuperAdminGuard],
})
export class DeprovisioningModule {}
