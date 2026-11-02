import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module.js';
import { CalendarController, ImportController, InvitationController } from './calendar.controller.js';
import { CalendarService } from './calendar.service.js';
import { ColleaguesRepository } from './colleagues.repository.js';
import { ImportService } from './import.service.js';
import { InvitationService } from './invitation.service.js';

@Module({
  imports: [MailModule],
  controllers: [CalendarController, InvitationController, ImportController],
  providers: [CalendarService, InvitationService, ColleaguesRepository, ImportService],
})
export class CalendarModule {}
