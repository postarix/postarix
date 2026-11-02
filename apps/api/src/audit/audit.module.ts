import { Global, Module } from '@nestjs/common';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, OrgAccessGuard],
  exports: [AuditService],
})
export class AuditModule {}
