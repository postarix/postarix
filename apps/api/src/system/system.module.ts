import { Module } from '@nestjs/common';
import { SystemController, SystemReportsController } from './system.controller.js';
import { SystemService } from './system.service.js';

@Module({
  controllers: [SystemReportsController, SystemController],
  providers: [SystemService],
})
export class SystemModule {}
