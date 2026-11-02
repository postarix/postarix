import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module.js';
import { CalendarController, InvitationController } from './calendar.controller.js';
import { CalendarService } from './calendar.service.js';
import { ColleaguesRepository } from './colleagues.repository.js';
import { InvitationService } from './invitation.service.js';

@Module({
  imports: [MailModule],
  controllers: [CalendarController, InvitationController],
  providers: [CalendarService, InvitationService, ColleaguesRepository],
})
export class CalendarModule {}
