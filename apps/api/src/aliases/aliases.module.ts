import { Module } from '@nestjs/common';
import { AddressRegistry } from '../common/address-registry.js';
import { DomainsModule } from '../domains/domains.module.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { AliasesController } from './aliases.controller.js';
import { AliasesRepository } from './aliases.repository.js';
import { AliasesService } from './aliases.service.js';

@Module({
  imports: [DomainsModule],
  controllers: [AliasesController],
  providers: [AliasesRepository, AliasesService, AddressRegistry, OrgAccessGuard],
})
export class AliasesModule {}
