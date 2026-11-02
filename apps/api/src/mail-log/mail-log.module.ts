import { Module } from '@nestjs/common';
import { DomainsModule } from '../domains/domains.module.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { MailLogController } from './mail-log.controller.js';
import { MailLogService } from './mail-log.service.js';

@Module({
  imports: [DomainsModule],
  controllers: [MailLogController],
  providers: [MailLogService, OrgAccessGuard],
})
export class MailLogModule {}
