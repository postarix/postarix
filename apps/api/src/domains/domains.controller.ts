import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';
import {
  type CreateDomainInput,
  createDomainSchema,
  type DnsRecordDto,
  type DomainDto,
  domainIdSchema,
  type DkimKeyDto,
  type ReplaceDkimInput,
  replaceDkimSchema,
  type UpdateDomainInput,
  updateDomainSchema,
} from './domains.dto.js';
import type { DnsRecordCheckDto } from './dns-check.js';
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

  /** Settings and, for instance administrators, limits. */
  @Patch(':id')
  @RequireOrgRole('admin')
  async update(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodValidationPipe(domainIdSchema)) id: string,
    @Body(new ZodValidationPipe(updateDomainSchema)) body: UpdateDomainInput,
  ): Promise<DomainDto> {
    return this.domains.update(ctx, id, body);
  }

  @Get(':id/dkim')
  async dkim(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodValidationPipe(domainIdSchema)) id: string,
  ): Promise<{ key: DkimKeyDto | null }> {
    return { key: await this.domains.dkimKey(ctx, id) };
  }

  /** A new signing key, generated or imported. */
  @Put(':id/dkim')
  @RequireOrgRole('admin')
  async replaceDkim(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodValidationPipe(domainIdSchema)) id: string,
    @Body(new ZodValidationPipe(replaceDkimSchema)) body: ReplaceDkimInput,
  ): Promise<DkimKeyDto> {
    return this.domains.replaceDkim(ctx, id, body);
  }

  @Get(':id/dns-records')
  async dnsRecords(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodValidationPipe(domainIdSchema)) id: string,
  ): Promise<{ data: DnsRecordDto[] }> {
    return { data: await this.domains.dnsRecords(ctx, id) };
  }

  /** Live check of the domain's DNS records (cached briefly; see DomainsService.dnsCheck). */
  @Get(':id/dns-check')
  @RequireOrgRole('admin')
  async dnsCheck(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodValidationPipe(domainIdSchema)) id: string,
  ): Promise<{ data: DnsRecordCheckDto[] }> {
    return { data: await this.domains.dnsCheck(ctx, id) };
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
