import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { AppPasswordsModule } from '../app-passwords/app-passwords.module.js';
import { InternalTokenGuard, MailAuthController } from './mail-auth.controller.js';
import { MailAuthService } from './mail-auth.service.js';

@Module({
  imports: [AccountsModule, AppPasswordsModule],
  controllers: [MailAuthController],
  providers: [MailAuthService, InternalTokenGuard],
})
export class MailAuthModule {}
