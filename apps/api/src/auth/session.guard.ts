import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import { AUTH } from '../core/tokens.js';
import type { Auth } from './auth.js';
import { SECOND_FACTOR_REQUIRED, SecondFactorPolicy } from './second-factor-policy.js';
import { ALLOW_WITHOUT_SECOND_FACTOR, type AuthenticatedRequest, IS_PUBLIC } from './session.js';

/**
 * Global guard: every route requires a valid Better Auth session unless it is
 * explicitly marked with @Public(), and a second factor when the person's
 * organization requires one (unless marked @AllowWithoutSecondFactor()).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SecondFactorPolicy) private readonly secondFactor: SecondFactorPolicy,
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
    const exempt = this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_SECOND_FACTOR, [context.getHandler(), context.getClass()]);
    if (!exempt && !(await this.secondFactor.satisfied(session.user.id))) {
      throw new ForbiddenException({
        message: 'Your organization requires a second sign-in step. Set up an authenticator app or a passkey in your account settings.',
        code: SECOND_FACTOR_REQUIRED,
      });
    }
    return true;
  }
}
