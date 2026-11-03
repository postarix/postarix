import { Module } from '@nestjs/common';
import { MailController } from './mail.controller.js';
import { MessageService } from './message.service.js';
import { SendService } from './send.service.js';
import { RateLimitsModule } from '../rate-limits/rate-limits.module.js';

@Module({
  imports: [RateLimitsModule],
  controllers: [MailController],
  providers: [SendService, MessageService],
  exports: [SendService],
})
export class MailModule {}
