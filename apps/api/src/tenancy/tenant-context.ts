import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/session.js';

/** Organization roles, from least to most privileged. Names match Better Auth's organization plugin. */
export const orgRoles = ['member', 'admin', 'owner'] as const;
export type OrgRole = (typeof orgRoles)[number];

/**
 * The organization a request is acting on, resolved and authorized by OrgAccessGuard.
 * Repositories receive it as their first argument and must scope every query by it.
 */
export interface TenantContext {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: OrgRole;
  /** True when access was granted through the instance super-admin role, not membership. */
  readonly viaSuperAdmin: boolean;
}

export interface TenantRequest extends AuthenticatedRequest {
  tenant?: TenantContext;
}

export const MIN_ORG_ROLE = 'postarix:minOrgRole';

/** Minimum organization role required by a route (default: any member). */
export const RequireOrgRole = (role: OrgRole) => SetMetadata(MIN_ORG_ROLE, role);

export const Tenant = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<TenantRequest>();
  if (!request.tenant) {
    throw new Error('Tenant context missing: is OrgAccessGuard applied to this route?');
  }
  return request.tenant;
});

export function roleRank(role: OrgRole): number {
  return orgRoles.indexOf(role);
}

/**
 * Better Auth stores a member's roles as a comma-separated string. Returns the
 * highest known role, or null if none is recognised.
 */
export function highestRole(raw: string): OrgRole | null {
  let best: OrgRole | null = null;
  for (const part of raw.split(',')) {
    const role = part.trim() as OrgRole;
    if (!orgRoles.includes(role)) continue;
    if (best === null || roleRank(role) > roleRank(best)) best = role;
  }
  return best;
}
