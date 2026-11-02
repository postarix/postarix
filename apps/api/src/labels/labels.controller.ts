import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { createLabelSchema, type LabelDto, LabelsService } from './labels.service.js';

/** The signed-in person's mail labels. */
@Controller('me/labels')
export class LabelsController {
  constructor(@Inject(LabelsService) private readonly labels: LabelsService) {}

  @Get()
  async list(@CurrentSession() session: AuthSession): Promise<{ data: LabelDto[] }> {
    return { data: await this.labels.list(session.user.id) };
  }

  @Post()
  create(
    @CurrentSession() session: AuthSession,
    @Body(new ZodValidationPipe(createLabelSchema)) body: z.infer<typeof createLabelSchema>,
  ): Promise<LabelDto> {
    return this.labels.create(session.user.id, body.name);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentSession() session: AuthSession, @Param('id', new ZodValidationPipe(z.uuid())) id: string): Promise<void> {
    await this.labels.remove(session.user.id, id);
  }
}
