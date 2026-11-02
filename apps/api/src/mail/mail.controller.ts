import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SendService, sendSchema } from './send.service.js';

/** The signed-in user's own mail (webmail). Everything acts on their own mailbox. */
@Controller('mail')
export class MailController {
  constructor(@Inject(SendService) private readonly sender: SendService) {}

  @Post('send')
  @HttpCode(200)
  send(
    @CurrentSession() session: AuthSession,
    @Body(new ZodValidationPipe(sendSchema)) body: { emailId: string },
  ): Promise<{ sent: true; movedToSent: boolean }> {
    return this.sender.send(session.user.id, body.emailId);
  }
}
