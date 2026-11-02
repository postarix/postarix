import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import { AUTH } from '../core/tokens.js';
import type { Auth } from './auth.js';
import { type AuthenticatedRequest, IS_PUBLIC } from './session.js';

/**
 * Global guard: every route requires a valid Better Auth session unless it is
 * explicitly marked with @Public().
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    if (!session) throw new UnauthorizedException();

    request.auth = session;
    return true;
  }
}
