import { Module } from '@nestjs/common';
import { AppPasswordsController } from './app-passwords.controller.js';
import { AppPasswordsService } from './app-passwords.service.js';

@Module({
  controllers: [AppPasswordsController],
  providers: [AppPasswordsService],
  exports: [AppPasswordsService],
})
export class AppPasswordsModule {}
