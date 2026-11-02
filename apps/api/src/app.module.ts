import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SessionGuard } from './auth/session.guard.js';
import { CoreModule } from './core/core.module.js';
import { DomainsModule } from './domains/domains.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [CoreModule, DomainsModule],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: SessionGuard }],
})
export class AppModule {}
