import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';
import {
  type CreateDomainInput,
  createDomainSchema,
  type DomainDto,
  domainIdSchema,
} from './domains.dto.js';
import { DomainsService } from './domains.service.js';

@Controller('orgs/:orgId/domains')
@UseGuards(OrgAccessGuard)
export class DomainsController {
  constructor(@Inject(DomainsService) private readonly domains: DomainsService) {}

  @Get()
  async list(@Tenant() ctx: TenantContext): Promise<{ data: DomainDto[] }> {
    return { data: await this.domains.list(ctx) };
  }

  @Get(':id')
  async get(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodValidationPipe(domainIdSchema)) id: string,
  ): Promise<DomainDto> {
    return this.domains.get(ctx, id);
  }

  @Post()
  @RequireOrgRole('admin')
  async create(
    @Tenant() ctx: TenantContext,
    @Body(new ZodValidationPipe(createDomainSchema)) body: CreateDomainInput,
  ): Promise<DomainDto> {
    return this.domains.create(ctx, body);
  }

  @Post(':id/verify')
  @RequireOrgRole('admin')
  @HttpCode(200)
  async verify(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodValidationPipe(domainIdSchema)) id: string,
  ): Promise<DomainDto> {
    return this.domains.verify(ctx, id);
  }

  @Delete(':id')
  @RequireOrgRole('admin')
  @HttpCode(204)
  async remove(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodValidationPipe(domainIdSchema)) id: string,
  ): Promise<void> {
    await this.domains.remove(ctx, id);
  }
}
