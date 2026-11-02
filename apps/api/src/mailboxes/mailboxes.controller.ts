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
  type CreateMailboxInput,
  createMailboxSchema,
  type MailboxDto,
  mailboxIdSchema,
  setPasswordSchema,
  type UpdateMailboxInput,
  updateMailboxSchema,
} from './mailboxes.dto.js';
import { type MailboxUsageDto, MailboxesService } from './mailboxes.service.js';

const idPipe = new ZodValidationPipe(mailboxIdSchema);

@Controller('orgs/:orgId/mailboxes')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class MailboxesController {
  constructor(@Inject(MailboxesService) private readonly mailboxes: MailboxesService) {}

  @Get()
  async list(@Tenant() ctx: TenantContext): Promise<{ data: MailboxDto[] }> {
    return { data: await this.mailboxes.list(ctx) };
  }

  @Get(':id')
  get(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string): Promise<MailboxDto> {
    return this.mailboxes.get(ctx, id);
  }

  @Get(':id/usage')
  usage(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string): Promise<MailboxUsageDto> {
    return this.mailboxes.usage(ctx, id);
  }

  @Post()
  create(
    @Tenant() ctx: TenantContext,
    @Body(new ZodValidationPipe(createMailboxSchema)) body: CreateMailboxInput,
  ): Promise<MailboxDto> {
    return this.mailboxes.create(ctx, body);
  }

  @Patch(':id')
  update(
    @Tenant() ctx: TenantContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateMailboxSchema)) body: UpdateMailboxInput,
  ): Promise<MailboxDto> {
    return this.mailboxes.update(ctx, id, body);
  }

  @Post(':id/password')
  @HttpCode(204)
  async setPassword(
    @Tenant() ctx: TenantContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(setPasswordSchema)) body: { password: string },
  ): Promise<void> {
    await this.mailboxes.setPassword(ctx, id, body.password);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string): Promise<void> {
    await this.mailboxes.remove(ctx, id);
  }
}
