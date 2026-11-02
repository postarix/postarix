import { Module } from '@nestjs/common';
import { DomainsModule } from '../domains/domains.module.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { SsoController } from './sso.controller.js';
import { SsoRepository } from './sso.repository.js';
import { SsoService } from './sso.service.js';

@Module({
  imports: [DomainsModule],
  controllers: [SsoController],
  providers: [SsoRepository, SsoService, OrgAccessGuard],
  exports: [SsoService],
})
export class SsoModule {}
