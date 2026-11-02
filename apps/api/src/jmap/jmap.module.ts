import { Module } from '@nestjs/common';
import { JmapProxy } from './jmap-proxy.js';

@Module({
  providers: [JmapProxy],
  exports: [JmapProxy],
})
export class JmapModule {}
