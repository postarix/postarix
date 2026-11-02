import { Module } from '@nestjs/common';
import { MailController } from './mail.controller.js';
import { MessageService } from './message.service.js';
import { SendService } from './send.service.js';

@Module({
  controllers: [MailController],
  providers: [SendService, MessageService],
})
export class MailModule {}
