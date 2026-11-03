import { Module } from '@nestjs/common';
import { SystemController, SystemReportsController } from './system.controller.js';
import { RspamdService } from './rspamd.js';
import { RspamdUiProxy } from './rspamd-ui-proxy.js';
import { SystemService } from './system.service.js';

@Module({
  controllers: [SystemReportsController, SystemController],
  providers: [SystemService, RspamdService, RspamdUiProxy],
  exports: [RspamdUiProxy],
})
export class SystemModule {}
