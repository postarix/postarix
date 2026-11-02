import { Module } from '@nestjs/common';
import { MailSettingsController } from './mail-settings.controller.js';
import { MailSettingsService } from './mail-settings.service.js';

@Module({
  controllers: [MailSettingsController],
  providers: [MailSettingsService],
})
export class MailSettingsModule {}
