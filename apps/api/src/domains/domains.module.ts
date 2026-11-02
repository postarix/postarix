import { Module } from '@nestjs/common';
import { DkimModule } from '../dkim/dkim.module.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { DomainsController } from './domains.controller.js';
import { DomainsRepository } from './domains.repository.js';
import { DomainsService } from './domains.service.js';

@Module({
  imports: [DkimModule],
  controllers: [DomainsController],
  providers: [DomainsRepository, DomainsService, OrgAccessGuard],
  exports: [DomainsRepository],
})
export class DomainsModule {}
