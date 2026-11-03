import { Module } from '@nestjs/common';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { MailImportController } from './mail-import.controller.js';
import { MailImportService } from './mail-import.service.js';
import { SyncJobsController } from './sync-jobs.controller.js';

@Module({
  controllers: [MailImportController, SyncJobsController],
  providers: [MailImportService, OrgAccessGuard],
})
export class MailImportModule {}
