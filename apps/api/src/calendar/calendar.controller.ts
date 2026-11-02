import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, UnsupportedMediaTypeException } from '@nestjs/common';
import type { z } from 'zod';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  type Availability,
  availabilityQuerySchema,
  CalendarService,
  collectionIdSchema,
  collectionKindSchema,
  eventIdSchema,
  type Guest,
  guestsSchema,
  type SharedCollection,
  sharesSchema,
} from './calendar.service.js';
import { type ImportResult, importQuerySchema, ImportService } from './import.service.js';
import { type Invitation, InvitationService, respondSchema } from './invitation.service.js';

/** The signed-in person's calendar: guests, free/busy of colleagues, sharing. */
@Controller('calendar')
export class CalendarController {
  constructor(@Inject(CalendarService) private readonly calendar: CalendarService) {}

  /** Sets who is invited to one of the person's events, and emails them. */
  @Put('events/:eventId/guests')
  setGuests(
    @CurrentSession() session: AuthSession,
    @Param('eventId', new ZodValidationPipe(eventIdSchema)) eventId: string,
    @Body(new ZodValidationPipe(guestsSchema)) body: z.infer<typeof guestsSchema>,
  ): Promise<{ guests: Guest[]; notified: number }> {
    return this.calendar.setGuests(session.user.id, eventId, body.guests);
  }

  /** Deletes an event and tells its guests. */
  @Post('events/:eventId/cancel')
  @HttpCode(200)
  cancel(
    @CurrentSession() session: AuthSession,
    @Param('eventId', new ZodValidationPipe(eventIdSchema)) eventId: string,
  ): Promise<{ notified: number }> {
    return this.calendar.cancel(session.user.id, eventId);
  }

  /** When colleagues in the person's organization are busy. */
  @Get('availability')
  availability(
    @CurrentSession() session: AuthSession,
    @Query(new ZodValidationPipe(availabilityQuerySchema)) query: z.infer<typeof availabilityQuerySchema>,
  ): Promise<{ data: Availability[]; unavailable: string[] }> {
    return this.calendar.availability(session.user.id, query.emails, new Date(query.from), new Date(query.to));
  }

  @Get('sharing')
  sharing(@CurrentSession() session: AuthSession): Promise<{ calendars: SharedCollection[]; addressBooks: SharedCollection[] }> {
    return this.calendar.sharing(session.user.id);
  }

  /** Replaces who a calendar ("calendars") or the contacts ("address-books") are shared with. */
  @Put('sharing/:kind/:id')
  setSharing(
    @CurrentSession() session: AuthSession,
    @Param('kind', new ZodValidationPipe(collectionKindSchema)) kind: z.infer<typeof collectionKindSchema>,
    @Param('id', new ZodValidationPipe(collectionIdSchema)) id: string,
    @Body(new ZodValidationPipe(sharesSchema)) body: z.infer<typeof sharesSchema>,
  ): Promise<SharedCollection> {
    return this.calendar.setSharing(session.user.id, kind === 'calendars' ? 'calendar' : 'addressbook', id, body.shares);
  }
}

/** Calendar messages (invitations, replies, cancellations) in the person's mail. */
@Controller('mail/messages/:emailId/invitation')
export class InvitationController {
  constructor(@Inject(InvitationService) private readonly invitations: InvitationService) {}

  @Get()
  find(
    @CurrentSession() session: AuthSession,
    @Param('emailId', new ZodValidationPipe(eventIdSchema)) emailId: string,
  ): Promise<Invitation> {
    return this.invitations.find(session.user.id, emailId);
  }

  /** Accepts, tentatively accepts or declines an invitation. */
  @Post('respond')
  @HttpCode(200)
  respond(
    @CurrentSession() session: AuthSession,
    @Param('emailId', new ZodValidationPipe(eventIdSchema)) emailId: string,
    @Body(new ZodValidationPipe(respondSchema)) body: z.infer<typeof respondSchema>,
  ): Promise<Invitation> {
    return this.invitations.respond(session.user.id, emailId, body.response);
  }

  /** Applies a reply or a cancellation to the person's calendar. */
  @Post('apply')
  @HttpCode(200)
  apply(
    @CurrentSession() session: AuthSession,
    @Param('emailId', new ZodValidationPipe(eventIdSchema)) emailId: string,
  ): Promise<Invitation> {
    return this.invitations.apply(session.user.id, emailId);
  }
}

/**
 * Imports another service's exports into the signed-in person's calendar and
 * contacts. The body is the file itself: Content-Type text/calendar (.ics) or
 * text/vcard (.vcf), up to 10 MB.
 */
@Controller()
export class ImportController {
  constructor(@Inject(ImportService) private readonly imports: ImportService) {}

  @Post('calendar/import')
  @HttpCode(200)
  importCalendar(
    @CurrentSession() session: AuthSession,
    @Body() body: unknown,
    @Query(new ZodValidationPipe(importQuerySchema)) query: z.infer<typeof importQuerySchema>,
  ): Promise<ImportResult> {
    return this.imports.importCalendar(session.user.id, fileBody(body), query.calendarId);
  }

  @Post('contacts/import')
  @HttpCode(200)
  importContacts(@CurrentSession() session: AuthSession, @Body() body: unknown): Promise<ImportResult> {
    return this.imports.importContacts(session.user.id, fileBody(body));
  }
}

function fileBody(body: unknown): string {
  if (typeof body !== 'string' || body.length === 0) throw new UnsupportedMediaTypeException('Send the file as text/calendar or text/vcard');
  return body;
}
