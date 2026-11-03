import { Module } from '@nestjs/common';
import { DkimModule } from '../dkim/dkim.module.js';
import { RateLimitsModule } from '../rate-limits/rate-limits.module.js';
import { SpamModule } from '../spam/spam.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { DomainsController } from './domains.controller.js';
import { DomainsRepository } from './domains.repository.js';
import { DomainsService } from './domains.service.js';

@Module({
  imports: [DkimModule, RateLimitsModule, SpamModule],
  controllers: [DomainsController],
  providers: [DomainsRepository, DomainsService, OrgAccessGuard],
  exports: [DomainsRepository, DomainsService],
})
export class DomainsModule {}
