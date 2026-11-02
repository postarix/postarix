import { secretFor } from '../config/internal-secrets.js';
import { internalTlsEnabled, viaInternalTls } from '../internal-tls.js';
import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { Public } from '../auth/session.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { Env } from '../config/env.js';
import { ENV } from '../core/tokens.js';
import { mailLogins, serviceLabel } from '../metrics/metrics.js';
import { type MailLoginAttempt, MailAuthService, mailLoginSchema } from './mail-auth.service.js';

export const INTERNAL_TOKEN_HEADER = 'x-postarix-internal-token';

/**
 * Protects /api/internal/*: requires the mail-login secret (see
 * internal-secrets.ts). When none is configured the endpoints do not exist (404).
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = secretFor(this.env, 'mail-auth');
    if (!expected) throw new NotFoundException();

    const request = context.switchToHttp().getRequest<Request>();
    // With the internal HTTPS listener on, nothing internal answers in clear.
    if (internalTlsEnabled(this.env) && !viaInternalTls(request, this.env)) throw new NotFoundException();
    // The login bridge calls us directly inside the Docker network. A request
    // that went through a reverse proxy means the proxy exposes internal
    // routes by mistake: refuse it as if the route did not exist.
    if (request.headers['x-forwarded-for'] !== undefined || request.headers.forwarded !== undefined) {
      throw new NotFoundException();
    }

    const provided = request.headers[INTERNAL_TOKEN_HEADER];
    if (typeof provided !== 'string') throw new UnauthorizedException();

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException();
    return true;
  }
}

/** Login bridge for saslauthd (via PAM). Never exposed through the reverse proxy. */
@Controller('internal')
@Public()
@UseGuards(InternalTokenGuard)
export class MailAuthController {
  constructor(@Inject(MailAuthService) private readonly mailAuth: MailAuthService) {}

  @Post('mail-auth')
  @HttpCode(204)
  async authenticate(
    @Body(new ZodValidationPipe(mailLoginSchema)) body: MailLoginAttempt,
  ): Promise<void> {
    const ok = await this.mailAuth.authenticate(body);
    mailLogins.inc({ service: serviceLabel(body.service), result: ok ? 'success' : 'failure' });
    if (!ok) throw new UnauthorizedException();
  }
}
