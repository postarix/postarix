import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { isSuperAdmin } from '../auth/session.js';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { member, organization } from '../db/schema/index.js';
import {
  highestRole,
  MIN_ORG_ROLE,
  type OrgRole,
  roleRank,
  type TenantRequest,
} from './tenant-context.js';

/**
 * Resolves the `:orgId` route parameter into a TenantContext.
 *
 * - Non-members get 404 (not 403) so organization IDs cannot be probed.
 * - Members below the route's minimum role get 403.
 * - Instance super-admins are granted owner-level access to any organization.
 */
@Injectable()
export class OrgAccessGuard implements CanActivate {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantRequest>();
    const session = request.auth;
    if (!session) throw new UnauthorizedException();

    const organizationId = request.params.orgId;
    if (typeof organizationId !== 'string' || organizationId.length === 0) {
      throw new NotFoundException();
    }

    const minRole =
      this.reflector.getAllAndOverride<OrgRole>(MIN_ORG_ROLE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'member';

    let role: OrgRole | null = null;
    let viaSuperAdmin = false;

    const [membership] = await this.db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, session.user.id)))
      .limit(1);

    if (membership) role = highestRole(membership.role);

    // Super-admins get owner-level access even where they are also a plain member.
    if (role !== 'owner' && isSuperAdmin(session)) {
      const [org] = await this.db
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, organizationId))
        .limit(1);
      if (org) {
        role = 'owner';
        viaSuperAdmin = true;
      }
    }

    if (role === null) throw new NotFoundException();
    if (roleRank(role) < roleRank(minRole)) throw new ForbiddenException();

    request.tenant = {
      organizationId,
      userId: session.user.id,
      userEmail: session.user.email,
      ipAddress: request.ip ?? null,
      role,
      viaSuperAdmin,
      instanceAdmin: isSuperAdmin(session),
    };
    return true;
  }
}
