import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';
import { type CreateSsoProviderInput, createSsoProviderSchema, type SsoProviderDto, ssoProviderIdSchema } from './sso.dto.js';
import { SsoService } from './sso.service.js';

@Controller('orgs/:orgId/sso')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class SsoController {
  constructor(@Inject(SsoService) private readonly sso: SsoService) {}

  @Get()
  async list(@Tenant() ctx: TenantContext): Promise<{ data: SsoProviderDto[] }> {
    return { data: await this.sso.list(ctx) };
  }

  // Only owners connect or remove a provider: it decides who can sign in as
  // anyone in the organization, owners included.
  @Post()
  @RequireOrgRole('owner')
  create(
    @Tenant() ctx: TenantContext,
    @Body(new ZodValidationPipe(createSsoProviderSchema)) body: CreateSsoProviderInput,
  ): Promise<SsoProviderDto> {
    return this.sso.create(ctx, body);
  }

  @Delete(':id')
  @RequireOrgRole('owner')
  @HttpCode(204)
  async remove(@Tenant() ctx: TenantContext, @Param('id', new ZodValidationPipe(ssoProviderIdSchema)) id: string): Promise<void> {
    await this.sso.remove(ctx, id);
  }
}
