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
import { z } from 'zod';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { SuperAdminGuard } from '../auth/super-admin.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';
import {
  addMemberSchema,
  type MemberDto,
  type OrganizationSummaryDto,
  OrganizationsService,
  updateMemberSchema,
} from './organizations.service.js';

@Controller('me/organizations')
export class MyOrganizationsController {
  constructor(@Inject(OrganizationsService) private readonly organizations: OrganizationsService) {}

  @Get()
  async list(@CurrentSession() session: AuthSession): Promise<{ data: OrganizationSummaryDto[] }> {
    return { data: await this.organizations.listForUser(session.user.id) };
  }
}

@Controller('admin/organizations')
@UseGuards(SuperAdminGuard)
export class AdminOrganizationsController {
  constructor(@Inject(OrganizationsService) private readonly organizations: OrganizationsService) {}

  @Get()
  async list(): Promise<{ data: OrganizationSummaryDto[] }> {
    return { data: await this.organizations.listAll() };
  }
}

@Controller('orgs/:orgId')
@UseGuards(OrgAccessGuard)
export class OrganizationController {
  constructor(@Inject(OrganizationsService) private readonly organizations: OrganizationsService) {}

  @Get('overview')
  overview(@Tenant() ctx: TenantContext) {
    return this.organizations.overview(ctx);
  }

  @Get('members')
  @RequireOrgRole('admin')
  async members(@Tenant() ctx: TenantContext): Promise<{ data: MemberDto[] }> {
    return { data: await this.organizations.listMembers(ctx) };
  }

  @Post('members')
  @RequireOrgRole('admin')
  addMember(
    @Tenant() ctx: TenantContext,
    @Body(new ZodValidationPipe(addMemberSchema)) body: z.infer<typeof addMemberSchema>,
  ): Promise<MemberDto> {
    return this.organizations.addMember(ctx, body);
  }

  @Patch('members/:memberId')
  @RequireOrgRole('admin')
  updateMember(
    @Tenant() ctx: TenantContext,
    @Param('memberId', new ZodValidationPipe(z.string().min(1).max(64))) memberId: string,
    @Body(new ZodValidationPipe(updateMemberSchema)) body: z.infer<typeof updateMemberSchema>,
  ): Promise<MemberDto> {
    return this.organizations.updateMember(ctx, memberId, body.role);
  }

  @Delete('members/:memberId')
  @RequireOrgRole('admin')
  @HttpCode(204)
  async removeMember(
    @Tenant() ctx: TenantContext,
    @Param('memberId', new ZodValidationPipe(z.string().min(1).max(64))) memberId: string,
  ): Promise<void> {
    await this.organizations.removeMember(ctx, memberId);
  }
}
