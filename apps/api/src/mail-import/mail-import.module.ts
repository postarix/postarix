import { Module } from '@nestjs/common';
import { MailImportController } from './mail-import.controller.js';
import { MailImportService } from './mail-import.service.js';

@Module({
  controllers: [MailImportController],
  providers: [MailImportService],
})
export class MailImportModule {}
