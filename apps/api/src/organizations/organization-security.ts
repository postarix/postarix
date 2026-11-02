import { Body, Controller, Get, Inject, Injectable, Put, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { type SecondFactorStatus, SecondFactorPolicy } from '../auth/second-factor-policy.js';
import { AllowWithoutSecondFactor, type AuthSession, CurrentSession } from '../auth/session.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { organizationSecurity } from '../db/schema/index.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';

export const organizationSecuritySchema = z.strictObject({ requireSecondFactor: z.boolean() });
export type OrganizationSecurityDto = z.infer<typeof organizationSecuritySchema>;

@Injectable()
export class OrganizationSecurityService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SecondFactorPolicy) private readonly policy: SecondFactorPolicy,
  ) {}

  async get(ctx: TenantContext): Promise<OrganizationSecurityDto> {
    const [row] = await this.db
      .select({ requireSecondFactor: organizationSecurity.requireSecondFactor })
      .from(organizationSecurity)
      .where(eq(organizationSecurity.organizationId, ctx.organizationId))
      .limit(1);
    return { requireSecondFactor: row?.requireSecondFactor ?? false };
  }

  async update(ctx: TenantContext, input: OrganizationSecurityDto): Promise<OrganizationSecurityDto> {
    // Whoever turns the rule on must already follow it, or they would lock themselves out.
    if (input.requireSecondFactor && !(await this.policy.status(ctx.userId)).enrolled) {
      throw new UnprocessableEntityException({
        message: 'Set up an authenticator app or a passkey for your own account first.',
        code: 'SECOND_FACTOR_NOT_SET_UP',
      });
    }
    const before = await this.get(ctx);
    await this.db
      .insert(organizationSecurity)
      .values({ organizationId: ctx.organizationId, requireSecondFactor: input.requireSecondFactor })
      .onConflictDoUpdate({ target: organizationSecurity.organizationId, set: { requireSecondFactor: input.requireSecondFactor } });
    if (before.requireSecondFactor !== input.requireSecondFactor) {
      await this.audit.record(
        ctx,
        input.requireSecondFactor ? 'organization.second_factor_required' : 'organization.second_factor_optional',
        { type: 'organization', id: ctx.organizationId },
      );
    }
    return input;
  }
}

/** Security rules of an organization (admins). */
@Controller('orgs/:orgId/security')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class OrganizationSecurityController {
  constructor(@Inject(OrganizationSecurityService) private readonly security: OrganizationSecurityService) {}

  @Get()
  get(@Tenant() ctx: TenantContext): Promise<OrganizationSecurityDto> {
    return this.security.get(ctx);
  }

  @Put()
  update(
    @Tenant() ctx: TenantContext,
    @Body(new ZodValidationPipe(organizationSecuritySchema)) body: OrganizationSecurityDto,
  ): Promise<OrganizationSecurityDto> {
    return this.security.update(ctx, body);
  }
}

/** Whether the signed-in person must set up a second factor before using Postarix. */
@Controller('me/second-factor')
export class MySecondFactorController {
  constructor(@Inject(SecondFactorPolicy) private readonly policy: SecondFactorPolicy) {}

  @Get()
  @AllowWithoutSecondFactor()
  status(@CurrentSession() session: AuthSession): Promise<SecondFactorStatus> {
    return this.policy.status(session.user.id);
  }
}
