import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';
import { type AuditEventDto, AuditService, decodeCursor } from './audit.service.js';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z
    .string()
    .max(200)
    .transform((value, ctx) => {
      const cursor = decodeCursor(value);
      if (!cursor) {
        ctx.addIssue({ code: 'custom', message: 'Invalid cursor' });
        return z.NEVER;
      }
      return cursor;
    })
    .optional(),
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
  ): Promise<{ data: AuditEventDto[]; nextCursor: string | null }> {
    return this.audit.list(ctx, { limit: query.limit, cursor: query.cursor });
  }
}
