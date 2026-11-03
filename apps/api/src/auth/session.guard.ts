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
import { ApiKeysService } from '../api-keys/api-keys.js';
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
    @Inject(ApiKeysService) private readonly apiKeys: ApiKeysService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Software with an API key (instance-administrator access; no second factor).
    const authorization = request.headers.authorization;
    if (typeof authorization === 'string' && /^Bearer\s+px_/i.test(authorization)) {
      const keySession = await this.apiKeys.authenticate(
        authorization.replace(/^Bearer\s+/i, '').trim(),
        request.ip,
        request.method,
        (request.originalUrl ?? request.url ?? '').split('?')[0],
      );
      if (!keySession) throw new UnauthorizedException('Invalid API key, or not allowed for this request');
      request.auth = keySession;
      return true;
    }
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    if (!session) throw new UnauthorizedException();

    request.auth = session;
    const exempt = this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_SECOND_FACTOR, [context.getHandler(), context.getClass()]);
    if (!exempt && !(await this.secondFactor.satisfied(session.user.id, session.session.id))) {
      throw new ForbiddenException({
        message: 'Your organization requires a second sign-in step: sign in with your passkey or authenticator app, or set one up in your account settings.',
        code: SECOND_FACTOR_REQUIRED,
      });
    }
    return true;
  }
}
