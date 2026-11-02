import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { type MailSettingsDto, MailSettingsService } from './mail-settings.service.js';
import { type MailSettings, mailSettingsSchema } from './sieve-settings.js';

/** The signed-in user's automatic reply and forwarding. */
@Controller('me/mail-settings')
export class MailSettingsController {
  constructor(@Inject(MailSettingsService) private readonly settings: MailSettingsService) {}

  @Get()
  get(@CurrentSession() session: AuthSession): Promise<MailSettingsDto> {
    return this.settings.get(session.user.id);
  }

  @Put()
  update(
    @CurrentSession() session: AuthSession,
    @Body(new ZodValidationPipe(mailSettingsSchema)) body: MailSettings,
  ): Promise<MailSettingsDto> {
    return this.settings.update(session.user.id, body);
  }
}
