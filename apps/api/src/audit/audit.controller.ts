import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';
import { type AuditEventDto, AuditService } from './audit.service.js';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime().optional(),
});

@Controller('orgs/:orgId/audit')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  async list(
    @Tenant() ctx: TenantContext,
    @Query(new ZodValidationPipe(querySchema)) query: z.infer<typeof querySchema>,
  ): Promise<{ data: AuditEventDto[] }> {
    return {
      data: await this.audit.list(ctx, {
        limit: query.limit,
        before: query.before ? new Date(query.before) : undefined,
      }),
    };
  }
}
