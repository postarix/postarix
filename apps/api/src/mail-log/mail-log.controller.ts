import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';
import { type MailLogEntryDto, MailLogService } from './mail-log.service.js';

export const mailLogQuerySchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(500).default(200) });

@Controller('orgs/:orgId/mail-log')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class MailLogController {
  constructor(@Inject(MailLogService) private readonly log: MailLogService) {}

  @Get()
  async list(
    @Tenant() ctx: TenantContext,
    @Query(new ZodValidationPipe(mailLogQuerySchema)) query: { limit: number },
  ): Promise<{ data: MailLogEntryDto[] }> {
    return { data: await this.log.list(ctx, query.limit) };
  }
}
