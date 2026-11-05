import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { type AuthSession, CurrentSession, Public } from '../auth/session.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { Env } from '../config/env.js';
import { ENV } from '../core/tokens.js';
import { fetchRemoteImage, ImageProxyError, verifyImageLink } from './image-proxy.js';
import { MessageService, type RenderedMessage } from './message.service.js';
import { type Identities, SendService, sendSchema } from './send.service.js';

const emailIdSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/);
const renderQuerySchema = z.object({ remoteImages: z.enum(['0', '1']).default('0'), accountId: z.string().min(3).max(320).optional() });
const imageQuerySchema = z.object({ u: z.string().min(1).max(4096), e: z.string().max(20), s: z.string().max(100) });

/** The signed-in user's own mail (webmail). Everything acts on their own mailbox. */
@Controller('mail')
export class MailController {
  constructor(
    @Inject(SendService) private readonly sender: SendService,
    @Inject(MessageService) private readonly messages: MessageService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('send')
  @HttpCode(200)
  send(
    @CurrentSession() session: AuthSession,
    @Body(new ZodValidationPipe(sendSchema)) body: { emailId: string; accountId?: string | undefined },
  ): Promise<{ sent: true; movedToSent: boolean }> {
    return this.sender.send(session.user.id, body.emailId, body.accountId);
  }

  /** The addresses the user may send as (for the From field). */
  @Get('identities')
  identities(@CurrentSession() session: AuthSession): Promise<Identities> {
    return this.sender.identities(session.user.id);
  }

  /** A message rendered for display: sanitized HTML, remote images blocked unless asked for. */
  @Get('messages/:emailId')
  render(
    @CurrentSession() session: AuthSession,
    @Param('emailId', new ZodValidationPipe(emailIdSchema)) emailId: string,
    @Query(new ZodValidationPipe(renderQuerySchema)) query: z.infer<typeof renderQuerySchema>,
  ): Promise<RenderedMessage> {
    return this.messages.render(session.user.id, emailId, query.remoteImages === '1', query.accountId);
  }

  /**
   * Remote images of messages, fetched by the server. Public on purpose: the
   * message iframe is sandboxed (opaque origin, so no cookies are sent). The
   * signature, made when the message was rendered for a signed-in user, is
   * what authorizes the fetch.
   */
  @Public()
  @Get('image')
  async image(
    @Query(new ZodValidationPipe(imageQuerySchema)) query: z.infer<typeof imageQuerySchema>,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('content-security-policy', "default-src 'none'; sandbox");
    res.setHeader('x-content-type-options', 'nosniff');
    if (!verifyImageLink(this.env.AUTH_SECRET, query.u, query.e, query.s)) {
      res.status(403).json({ statusCode: 403, message: 'Invalid or expired image link' });
      return;
    }
    try {
      const image = await fetchRemoteImage(query.u);
      res.setHeader('content-type', image.type);
      res.setHeader('cache-control', 'private, max-age=86400');
      res.setHeader('content-disposition', 'inline');
      res.setHeader('cross-origin-resource-policy', 'cross-origin');
      res.status(200).end(image.body);
    } catch (error) {
      const status = error instanceof ImageProxyError ? error.status : 502;
      res.status(status).json({ statusCode: status, message: error instanceof Error ? error.message : 'Bad gateway' });
    }
  }
}
