import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import { AUTH } from '../core/tokens.js';
import { ApiKeysService } from '../api-keys/api-keys.js';
import type { Auth } from './auth.js';
import { openWhileImpersonating } from './impersonation.js';
import { SECOND_FACTOR_REQUIRED, SecondFactorPolicy } from './second-factor-policy.js';
import { ALLOW_WITHOUT_SECOND_FACTOR, type AuthenticatedRequest, type AuthSession, IS_PUBLIC } from './session.js';
import { type AppTokenGrant, AppTokensService } from '../connected-apps/app-tokens.js';
import type { AppTokenRequest } from '../connected-apps/unread.js';

/**
 * The API routes a connected application's token reaches (JMAP is checked by
 * the proxy): its own token, unread counts; a person's, their identities,
 * rendered messages (also under supervision) and sending.
 */
export function appTokenAllows(grant: AppTokenGrant, method: string, path: string): boolean {
  const p = path.replace(/\/+$/, '');
  const has = (scope: AppTokenGrant['scopes'][number]) => grant.scopes.includes(scope);
  if (grant.userId === null) return method === 'POST' && p === '/api/mail/unread' && has('mail.read');
  if (method === 'GET' && /^\/api\/mail\/messages\/[^/]+$/.test(p)) return has('mail.read') || has('mail.supervise');
  if (method === 'GET' && p === '/api/mail/identities') return has('mail.read');
  if (method === 'POST' && p === '/api/mail/send') return has('mail.send');
  return false;
}

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
    @Inject(AppTokensService) private readonly appTokens: AppTokensService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest & AppTokenRequest>();
    // A connected application acting for a person (or for itself): only the
    // mail routes it is scoped for. Its own users' sign-in is its business,
    // so no second factor is asked here (see docs/INTEGRATIONS.md).
    if (typeof request.headers.authorization === 'string' && /^Bearer\s+pxt_/i.test(request.headers.authorization)) {
      const grant = await this.appTokens.authenticate(request.headers.authorization.replace(/^Bearer\s+/i, '').trim(), request.ip);
      if (grant === 'limited') throw new HttpException('Too many requests from this application; slow down', 429);
      if (!grant) throw new UnauthorizedException('Invalid or expired token');
      const path = (request.originalUrl ?? request.url ?? '').split('?')[0] ?? '';
      if (!appTokenAllows(grant, request.method, path)) throw new ForbiddenException('This token is not for this request');
      request.appToken = grant;
      if (grant.userId) {
        request.auth = { user: { id: grant.userId }, session: { id: `app:${grant.appId}`, userId: grant.userId } } as unknown as AuthSession;
        if (grant.supervisionGrantId) await this.appTokens.logSupervision(grant, `${request.method} ${path}`);
      }
      return true;
    }
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
    // An administrator inside someone's mailbox ("Sign in as") reaches its
    // mail, calendar and settings only: no administration, no account security.
    if ((session.session as { impersonatedBy?: string | null }).impersonatedBy) {
      const path = (request.originalUrl ?? request.url ?? '').split('?')[0] ?? '';
      if (!openWhileImpersonating(path) && path !== '/api/me/impersonation/stop') {
        throw new ForbiddenException({ message: 'Not available while signed in as someone else', code: 'IMPERSONATING' });
      }
    }
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
