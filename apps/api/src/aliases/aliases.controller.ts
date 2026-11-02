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
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';
import {
  type AliasDto,
  aliasIdSchema,
  type CreateAliasInput,
  createAliasSchema,
  type UpdateAliasInput,
  updateAliasSchema,
} from './aliases.dto.js';
import { AliasesService } from './aliases.service.js';

const idPipe = new ZodValidationPipe(aliasIdSchema);

@Controller('orgs/:orgId/aliases')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class AliasesController {
  constructor(@Inject(AliasesService) private readonly aliases: AliasesService) {}

  @Get()
  async list(@Tenant() ctx: TenantContext): Promise<{ data: AliasDto[] }> {
    return { data: await this.aliases.list(ctx) };
  }

  @Get(':id')
  get(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string): Promise<AliasDto> {
    return this.aliases.get(ctx, id);
  }

  @Post()
  create(
    @Tenant() ctx: TenantContext,
    @Body(new ZodValidationPipe(createAliasSchema)) body: CreateAliasInput,
  ): Promise<AliasDto> {
    return this.aliases.create(ctx, body);
  }

  @Patch(':id')
  update(
    @Tenant() ctx: TenantContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateAliasSchema)) body: UpdateAliasInput,
  ): Promise<AliasDto> {
    return this.aliases.update(ctx, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string): Promise<void> {
    await this.aliases.remove(ctx, id);
  }
}
