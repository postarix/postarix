import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SessionGuard } from './auth/session.guard.js';
import { CoreModule } from './core/core.module.js';
import { AliasesModule } from './aliases/aliases.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AppPasswordsModule } from './app-passwords/app-passwords.module.js';
import { DomainsModule } from './domains/domains.module.js';
import { HealthController } from './health/health.controller.js';
import { MailAuthModule } from './mail-auth/mail-auth.module.js';
import { MailboxesModule } from './mailboxes/mailboxes.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';

@Module({
  imports: [
    CoreModule,
    AuditModule,
    OrganizationsModule,
    DomainsModule,
    MailboxesModule,
    AliasesModule,
    AppPasswordsModule,
    MailAuthModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: SessionGuard }],
})
export class AppModule {}
