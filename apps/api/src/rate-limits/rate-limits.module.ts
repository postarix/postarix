import { Module } from '@nestjs/common';
import { RateLimitsService } from './rate-limits.js';

@Module({
  providers: [RateLimitsService],
  exports: [RateLimitsService],
})
export class RateLimitsModule {}
