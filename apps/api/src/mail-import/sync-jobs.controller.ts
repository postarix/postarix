import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';
import { type CreateSyncJob, createSyncJobSchema, MailImportService, type SyncJobView } from './mail-import.service.js';

const idPipe = new ZodValidationPipe(z.uuid());
const listQuerySchema = z.strictObject({ mailboxId: z.uuid().optional() });

/** Organization admins: copy mail from other IMAP servers into their mailboxes, once or on a schedule. */
@Controller('orgs/:orgId/sync-jobs')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class SyncJobsController {
  constructor(
    @Inject(MailImportService) private readonly imports: MailImportService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  async list(
    @Tenant() ctx: TenantContext,
    @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ): Promise<{ data: SyncJobView[] }> {
    return { data: await this.imports.listSyncJobs(ctx, query.mailboxId) };
  }

  @Post()
  async create(@Tenant() ctx: TenantContext, @Body(new ZodValidationPipe(createSyncJobSchema)) body: CreateSyncJob): Promise<SyncJobView> {
    const job = await this.imports.createSyncJob(ctx, body);
    await this.audit.record(ctx, 'sync_job.created', { type: 'sync_job', id: job.id, label: `${job.username}@${job.host} → ${job.mailboxAddress}` });
    return job;
  }

  @Post(':id/run')
  @HttpCode(200)
  run(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string): Promise<SyncJobView> {
    return this.imports.runSyncJobNow(ctx, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string): Promise<SyncJobView> {
    const job = await this.imports.cancelSyncJob(ctx, id);
    await this.audit.record(ctx, 'sync_job.cancelled', { type: 'sync_job', id, label: `${job.username}@${job.host} → ${job.mailboxAddress}` });
    return job;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string): Promise<void> {
    const job = await this.imports.deleteSyncJob(ctx, id);
    await this.audit.record(ctx, 'sync_job.deleted', { type: 'sync_job', id, label: `${job.username}@${job.host} → ${job.mailboxAddress}` });
  }
}
