import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Auth } from './auth.js';
import { hasInstanceAdminRole } from './roles.js';

export type AuthSession = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;

export interface AuthenticatedRequest extends Request {
  auth?: AuthSession;
}

export const IS_PUBLIC = 'postarix:isPublic';

/** Marks a route as reachable without a session. Everything else requires one. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Injects the current Better Auth session ({ user, session }) into a handler. */
export const CurrentSession = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.auth;
});

export function isSuperAdmin(session: AuthSession): boolean {
  return hasInstanceAdminRole(session.user.role);
}
