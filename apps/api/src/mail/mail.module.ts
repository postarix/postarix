import { Module } from '@nestjs/common';
import { MailController } from './mail.controller.js';
import { SendService } from './send.service.js';

@Module({
  controllers: [MailController],
  providers: [SendService],
})
export class MailModule {}
