import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { type MailImportView, MailImportService, type StartImport, startImportSchema } from './mail-import.service.js';

/** The signed-in person's imports of mail from other servers (Gmail, an old provider…). */
@Controller('me/mail-imports')
export class MailImportController {
  constructor(@Inject(MailImportService) private readonly imports: MailImportService) {}

  @Get()
  async list(@CurrentSession() session: AuthSession): Promise<{ data: MailImportView[] }> {
    return { data: await this.imports.list(session.user.id) };
  }

  /** Checks the other account's settings and starts copying its mail. */
  @Post()
  start(@CurrentSession() session: AuthSession, @Body(new ZodValidationPipe(startImportSchema)) body: StartImport): Promise<MailImportView> {
    return this.imports.start(session.user.id, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentSession() session: AuthSession, @Param('id', new ParseUUIDPipe()) id: string): Promise<MailImportView> {
    return this.imports.cancel(session.user.id, id);
  }
}
