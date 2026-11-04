import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { Auth } from '../auth/auth.js';
import { IMPERSONATION_MS, mintImpersonationGrant } from '../auth/impersonation.js';
import { hasInstanceAdminRole } from '../auth/roles.js';
import { SecondFactorPolicy } from '../auth/second-factor-policy.js';
import { type AuthSession, CurrentSession, isSuperAdmin } from '../auth/session.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { Env } from '../config/env.js';
import { AUTH, DATABASE, ENV } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { mailboxes, user } from '../db/schema/index.js';
import { MailboxesModule } from '../mailboxes/mailboxes.module.js';
import { MailboxesRepository } from '../mailboxes/mailboxes.repository.js';
import { loadInstanceSettings } from '../settings/instance-settings.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';

export const impersonateSchema = z.strictObject({
  /** Why: kept in the activity log of the organization and of the instance. */
  reason: z.string().trim().min(5, 'Say why, in a few words').max(500),
});

/** The impersonated session's id, if this is one. */
function impersonatedBy(session: AuthSession): string | null {
  return (session.session as { impersonatedBy?: string | null }).impersonatedBy ?? null;
}

/** Copies Better Auth's cookies (the new session, the kept one) onto our response. */
function forwardCookies(headers: Headers | undefined, res: Response): void {
  const cookies = headers?.getSetCookie?.() ?? [];
  if (cookies.length) res.append('Set-Cookie', cookies);
}

@Injectable()
export class ImpersonationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(MailboxesRepository) private readonly mailboxes: MailboxesRepository,
    @Inject(SecondFactorPolicy) private readonly secondFactor: SecondFactorPolicy,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Opens a one-hour session as the mailbox's owner, if this administrator may:
   * instance administrators always (the organization's owners and admins when
   * the instance allows it), with a second factor on this session, never into
   * another instance administrator's account, and always with a reason.
   */
  async start(ctx: TenantContext, session: AuthSession, mailboxId: string, reason: string, req: Request, res: Response): Promise<{ expiresAt: string }> {
    if (impersonatedBy(session)) throw new ForbiddenException('Leave the mailbox you are in first');
    if (!ctx.instanceAdmin || !isSuperAdmin(session)) {
      const { impersonation } = await loadInstanceSettings(this.db);
      if (!impersonation.allowOrgAdmins) {
        throw new ForbiddenException('Only instance administrators may sign in as someone on this server');
      }
    }
    const { strongSession } = await this.secondFactor.status(session.user.id, session.session.id);
    if (!strongSession) {
      throw new ForbiddenException({
        message: 'Signing in as someone needs two-step verification: set it up and sign in with it first',
        code: 'SECOND_FACTOR_REQUIRED',
      });
    }
    const mailbox = await this.mailboxes.findById(ctx, mailboxId);
    if (!mailbox?.userId) throw new NotFoundException('Mailbox not found');
    const [owner] = await this.db.select({ id: user.id, role: user.role }).from(user).where(eq(user.id, mailbox.userId));
    if (!owner) throw new NotFoundException('Mailbox not found');
    if (owner.id === session.user.id) throw new ForbiddenException('This is your own mailbox');
    if (hasInstanceAdminRole(owner.role)) throw new ForbiddenException('Instance administrators’ mailboxes cannot be entered this way');

    const until = new Date(Date.now() + IMPERSONATION_MS).toISOString();
    await this.audit.record(ctx, 'mailbox.impersonation_started', { type: 'mailbox', id: mailbox.id, label: mailbox.address }, { reason, until });
    const result = await this.auth.api.postarixImpersonate({
      body: { targetUserId: owner.id, grant: mintImpersonationGrant(this.env.AUTH_SECRET, session.session.id, owner.id) },
      headers: fromNodeHeaders(req.headers),
      returnHeaders: true,
    });
    forwardCookies(result.headers, res);
    return { expiresAt: new Date(result.response.expiresAt).toISOString() };
  }

  /** Back to the administrator's own session; recorded in the mailbox's organization. */
  async stop(session: AuthSession, req: Request, res: Response): Promise<void> {
    const adminId = impersonatedBy(session);
    if (!adminId) throw new ForbiddenException('You are not signed in as someone else');
    const [mailbox] = await this.db
      .select({ id: mailboxes.id, address: mailboxes.address, organizationId: mailboxes.organizationId })
      .from(mailboxes)
      .where(eq(mailboxes.userId, session.user.id))
      .limit(1);
    const [admin] = await this.db.select({ email: user.email }).from(user).where(eq(user.id, adminId));
    const result = await this.auth.api.stopImpersonating({ headers: fromNodeHeaders(req.headers), returnHeaders: true });
    forwardCookies(result.headers, res);
    if (mailbox) {
      const minutes = Math.max(0, Math.round((Date.now() - new Date(session.session.createdAt).getTime()) / 60_000));
      await this.audit.record(
        {
          organizationId: mailbox.organizationId,
          userId: adminId,
          userEmail: admin?.email ?? '',
          ipAddress: req.ip ?? null,
          role: 'admin',
          viaSuperAdmin: false,
          instanceAdmin: false,
        },
        'mailbox.impersonation_ended',
        { type: 'mailbox', id: mailbox.id, label: mailbox.address },
        { minutes },
      );
    }
  }
}

/** Organization administrators (and instance administrators): "Sign in as" a mailbox. */
@Controller('orgs/:orgId/mailboxes/:mailboxId/impersonate')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class OrgImpersonationController {
  constructor(@Inject(ImpersonationService) private readonly impersonation: ImpersonationService) {}

  @Post()
  @HttpCode(200)
  start(
    @Tenant() ctx: TenantContext,
    @CurrentSession() session: AuthSession,
    @Param('mailboxId', new ZodValidationPipe(z.uuid())) mailboxId: string,
    @Body(new ZodValidationPipe(impersonateSchema)) body: z.infer<typeof impersonateSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ expiresAt: string }> {
    return this.impersonation.start(ctx, session, mailboxId, body.reason, req, res);
  }
}

/** The administrator inside someone's mailbox: back to their own session. */
@Controller('me/impersonation')
export class MyImpersonationController {
  constructor(@Inject(ImpersonationService) private readonly impersonation: ImpersonationService) {}

  @Post('stop')
  @HttpCode(204)
  async stop(@CurrentSession() session: AuthSession, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.impersonation.stop(session, req, res);
  }
}

@Module({
  imports: [MailboxesModule],
  controllers: [OrgImpersonationController, MyImpersonationController],
  providers: [ImpersonationService, OrgAccessGuard],
})
export class ImpersonationModule {}
