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
import { type MailLoginAttempt, MailAuthService, mailLoginSchema } from './mail-auth.service.js';

export const INTERNAL_TOKEN_HEADER = 'x-postarix-internal-token';

/**
 * Protects /api/internal/*: requires the shared INTERNAL_API_TOKEN. When no
 * token is configured the endpoints do not exist (404).
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.env.INTERNAL_API_TOKEN;
    if (!expected) throw new NotFoundException();

    const request = context.switchToHttp().getRequest<Request>();
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
    if (!(await this.mailAuth.authenticate(body))) throw new UnauthorizedException();
  }
}
