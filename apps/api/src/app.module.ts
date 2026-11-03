import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SessionGuard } from './auth/session.guard.js';
import { CoreModule } from './core/core.module.js';
import { AliasesModule } from './aliases/aliases.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AppPasswordsModule } from './app-passwords/app-passwords.module.js';
import { MailSettingsModule } from './mail-settings/mail-settings.module.js';
import { CalendarModule } from './calendar/calendar.module.js';
import { MailImportModule } from './mail-import/mail-import.module.js';
import { LabelsModule } from './labels/labels.module.js';
import { DomainsModule } from './domains/domains.module.js';
import { DeprovisioningModule } from './deprovisioning/deprovisioning.module.js';
import { DiscoveryModule } from './discovery/discovery.module.js';
import { SsoModule } from './sso/sso.module.js';
import { MailLogModule } from './mail-log/mail-log.module.js';
import { HealthController } from './health/health.controller.js';
import { JmapModule } from './jmap/jmap.module.js';
import { MailModule } from './mail/mail.module.js';
import { MailAuthModule } from './mail-auth/mail-auth.module.js';
import { MailboxesModule } from './mailboxes/mailboxes.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { SystemModule } from './system/system.module.js';
import { RoutingModule } from './routing/routing.js';
import { SpamModule } from './spam/spam.js';
import { QuarantineModule } from './quarantine/quarantine.js';

@Module({
  imports: [
    CoreModule,
    AuditModule,
    OrganizationsModule,
    DomainsModule,
    MailboxesModule,
    AliasesModule,
    AppPasswordsModule,
    MailSettingsModule,
    LabelsModule,
    CalendarModule,
    MailImportModule,
    MailAuthModule,
    JmapModule,
    MailModule,
    DiscoveryModule,
    DeprovisioningModule,
    SsoModule,
    MailLogModule,
    SystemModule,
    RoutingModule,
    SpamModule,
    QuarantineModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: SessionGuard }],
})
export class AppModule {}
