import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  type AppPasswordDto,
  AppPasswordsService,
  type CreateAppPasswordInput,
  createAppPasswordSchema,
} from './app-passwords.service.js';

/** The signed-in user's own app passwords. */
@Controller('me/app-passwords')
export class AppPasswordsController {
  constructor(@Inject(AppPasswordsService) private readonly appPasswords: AppPasswordsService) {}

  @Get()
  async list(@CurrentSession() session: AuthSession): Promise<{ data: AppPasswordDto[] }> {
    return { data: await this.appPasswords.list(session.user.id) };
  }

  @Post()
  create(
    @CurrentSession() session: AuthSession,
    @Body(new ZodValidationPipe(createAppPasswordSchema)) body: CreateAppPasswordInput,
  ): Promise<AppPasswordDto & { password: string }> {
    return this.appPasswords.create(session.user.id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(
    @CurrentSession() session: AuthSession,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ): Promise<void> {
    await this.appPasswords.revoke(session.user.id, id);
  }
}
