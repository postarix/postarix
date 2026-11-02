import { Module } from '@nestjs/common';
import { DkimService } from './dkim.service.js';

@Module({
  providers: [DkimService],
  exports: [DkimService],
})
export class DkimModule {}
