import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { MailEngine } from '@postarix/mail-engine';
import { z } from 'zod';
import { MAIL_ENGINE } from '../core/tokens.js';
import { ServerJmap } from '../mail/jmap-client.js';
import { SendService } from '../mail/send.service.js';
import {
  defaultCalendarId,
  downloadText,
  findByUid,
  jmapCall,
  MAX_ICS_BYTES,
  organizerOf,
  type Participant,
  participantEmail,
  type StoredEvent,
} from './calendar-jmap.js';
import { ColleaguesRepository } from './colleagues.repository.js';
import { buildReply, IcsError, type ItipSummary, readItip } from './ics.js';

export const respondSchema = z.strictObject({ response: z.enum(['accepted', 'tentative', 'declined']) });
export type InvitationResponse = z.infer<typeof respondSchema>['response'];

/** A calendar message in the person's mail, and what they can do with it. */
export interface Invitation extends ItipSummary {
  /** Who sent the message (its From address). */
  sender: string | null;
  /** The person's address among the attendees (REQUEST), or null. */
  attendee: string | null;
  /** The person's answer so far (REQUEST), from their calendar if it is there. */
  myStatus: string | null;
  /** The matching event in the person's calendar, if any. */
  eventId: string | null;
  /** REQUEST: they can answer. REPLY/CANCEL: they can apply it to their calendar. */
  actionable: boolean;
  /** REPLY/CANCEL: the calendar already reflects the message. */
  applied: boolean;
  /** The calendar holds a newer version of the event than this message. */
  outdated: boolean;
}

interface BodyPart {
  partId?: string | null;
  blobId?: string | null;
  type: string;
  size: number;
  subParts?: BodyPart[] | null;
}

const CALENDAR_TYPES = new Set(['text/calendar', 'application/ics']);

/** Event properties copied from an invitation into the person's calendar. */
const IMPORTED = [
  '@type',
  'uid',
  'title',
  'description',
  'descriptionContentType',
  'start',
  'timeZone',
  'duration',
  'showWithoutTime',
  'locations',
  'virtualLocations',
  'recurrenceRules',
  'excludedRecurrenceRules',
  'recurrenceOverrides',
  'participants',
  'replyTo',
  'sequence',
  'status',
  'freeBusyStatus',
  'privacy',
  'priority',
] as const;

/**
 * The attendee side of invitations: reading calendar messages (iMIP) in the
 * person's mail, answering them, and applying replies and cancellations.
 * Nothing happens without the person asking; a message only changes the
 * calendar when its sender is the organizer (cancellations) or the attendee
 * (replies) it speaks for.
 */
@Injectable()
export class InvitationService {
  constructor(
    @Inject(MAIL_ENGINE) private readonly engine: MailEngine,
    @Inject(ColleaguesRepository) private readonly colleagues: ColleaguesRepository,
    @Inject(SendService) private readonly sender: SendService,
  ) {}

  private async context(userId: string, emailId: string) {
    const own = await this.colleagues.own(userId);
    if (!own) throw new NotFoundException('You have no mailbox');
    const jmap = new ServerJmap(this.engine, own.address);
    const { list } = await jmapCall<{ list: { from: { email?: string | null }[] | null; bodyStructure: BodyPart }[] }>(jmap, 'Email/get', {
      ids: [emailId],
      properties: ['from', 'bodyStructure'],
      bodyProperties: ['partId', 'blobId', 'type', 'size', 'subParts'],
    });
    const email = list[0];
    if (!email) throw new NotFoundException('Message not found');
    const part = findCalendarPart(email.bodyStructure);
    if (!part?.blobId) throw new NotFoundException('This message has no invitation');
    if (part.size > MAX_ICS_BYTES) throw new UnprocessableEntityException('The calendar data is too large');
    const ics = await downloadText(jmap, part.blobId);
    let summary: ItipSummary;
    try {
      summary = readItip(ics);
    } catch (error) {
      if (error instanceof IcsError) throw new NotFoundException(`This message has no invitation Postarix can use: ${error.message}`);
      throw error;
    }
    const identities = new Set((await this.sender.identities(userId)).addresses.map((a) => a.toLowerCase()));
    const sender = email.from?.length === 1 ? (email.from[0]!.email ?? '').trim().toLowerCase() || null : null;
    const existing = await findByUid(jmap, summary.uid, ['sequence', 'replyTo', 'participants', 'calendarIds']);
    return { own, jmap, ics, summary, identities, sender, existing, blobId: part.blobId };
  }

  async find(userId: string, emailId: string): Promise<Invitation> {
    const { summary, identities, sender, existing } = await this.context(userId, emailId);
    const outdated = Boolean(existing && (existing.sequence ?? 0) > summary.sequence);
    const base = { ...summary, sender, eventId: existing?.id ?? null, outdated };

    if (summary.method === 'REQUEST') {
      const attendee = summary.attendees.find((a) => identities.has(a.email)) ?? null;
      const stored = existing ? Object.values(existing.participants ?? {}).find((p) => identities.has(participantEmail(p) ?? '')) : undefined;
      const organizerIsMe = Boolean(summary.organizer && identities.has(summary.organizer.email));
      return {
        ...base,
        attendee: attendee?.email ?? null,
        myStatus: stored?.participationStatus ?? attendee?.status ?? null,
        actionable: Boolean(attendee) && !organizerIsMe,
        applied: false,
      };
    }
    const check = this.checkApply(summary, identities, sender, existing);
    return { ...base, attendee: null, myStatus: null, actionable: check.ok, applied: check.applied };
  }

  /**
   * Whether a REPLY or CANCEL may change the person's calendar: the event
   * must be there, and the message must come from the person it speaks for.
   */
  private checkApply(
    summary: ItipSummary,
    identities: Set<string>,
    sender: string | null,
    existing: StoredEvent | null,
  ): { ok: boolean; applied: boolean; participantKey?: string } {
    if (!existing || !sender) return { ok: false, applied: summary.method === 'CANCEL' && !existing };
    const organizer = organizerOf(existing);
    if (summary.method === 'REPLY') {
      const answer = summary.attendees[0];
      if (summary.attendees.length !== 1 || !answer || answer.email !== sender) return { ok: false, applied: false };
      if (!organizer || !identities.has(organizer)) return { ok: false, applied: false };
      const entry = Object.entries(existing.participants ?? {}).find(([, p]) => participantEmail(p) === answer.email);
      if (!entry) return { ok: false, applied: false };
      if ((existing.sequence ?? 0) > summary.sequence) return { ok: false, applied: false };
      return { ok: true, applied: entry[1].participationStatus === answer.status, participantKey: entry[0] };
    }
    // CANCEL: only from the organizer of the event the person holds.
    if (!organizer || organizer !== sender || summary.organizer?.email !== sender) return { ok: false, applied: false };
    return { ok: true, applied: false };
  }

  /** Answers an invitation: updates the person's calendar and emails the organizer. */
  async respond(userId: string, emailId: string, response: InvitationResponse): Promise<Invitation> {
    const { jmap, ics, summary, identities, existing, blobId } = await this.context(userId, emailId);
    if (summary.method !== 'REQUEST') throw new UnprocessableEntityException('This message is not an invitation');
    const attendee = summary.attendees.find((a) => identities.has(a.email));
    if (!attendee) throw new ForbiddenException('This invitation is not addressed to you');
    const organizer = summary.organizer?.email;
    if (!organizer || identities.has(organizer)) throw new UnprocessableEntityException('You organize this event');
    if (existing && (existing.sequence ?? 0) > summary.sequence) {
      throw new ConflictException('Your calendar has a newer version of this event');
    }

    if (response === 'declined') {
      if (existing) await jmapCall(jmap, 'CalendarEvent/set', { destroy: [existing.id] });
    } else {
      const event = await this.importable(jmap, blobId, summary.uid);
      const participants = (event.participants ?? {}) as Record<string, Participant>;
      for (const participant of Object.values(participants)) {
        if (participantEmail(participant) === attendee.email) {
          participant.participationStatus = response;
          participant.expectReply = false;
        }
      }
      if (existing) {
        const patch: Record<string, unknown> = {};
        for (const key of IMPORTED) if (key !== '@type' && key !== 'uid') patch[key] = event[key] ?? null;
        const result = await jmapCall<{ notUpdated?: Record<string, { type: string; description?: string }> | null }>(jmap, 'CalendarEvent/set', {
          update: { [existing.id]: patch },
        });
        const failure = result.notUpdated?.[existing.id];
        if (failure) throw new UnprocessableEntityException(`Could not update your calendar: ${failure.description ?? failure.type}`);
      } else {
        const calendarId = await defaultCalendarId(jmap);
        const result = await jmapCall<{ notCreated?: Record<string, { type: string; description?: string }> | null }>(jmap, 'CalendarEvent/set', {
          create: { invitation: { ...event, calendarIds: { [calendarId]: true } } },
        });
        const failure = result.notCreated?.invitation;
        if (failure) throw new UnprocessableEntityException(`Could not add the event to your calendar: ${failure.description ?? failure.type}`);
      }
    }

    const verb = { accepted: 'Accepted', tentative: 'Tentatively accepted', declined: 'Declined' }[response];
    await this.sender.sendComposed(userId, {
      from: attendee.email,
      to: [organizer],
      subject: `${verb}: ${summary.title || '(no title)'}`,
      text: `${attendee.email} ${verb.toLowerCase()} "${summary.title || '(no title)'}".\n`,
      calendar: { method: 'REPLY', content: buildReply(ics, attendee.email, response) },
    });
    return this.find(userId, emailId);
  }

  /** Applies a reply (as organizer) or a cancellation (as attendee) to the person's calendar. */
  async apply(userId: string, emailId: string): Promise<Invitation> {
    const { jmap, summary, identities, sender, existing } = await this.context(userId, emailId);
    if (summary.method === 'REQUEST') throw new UnprocessableEntityException('Answer the invitation instead');
    const check = this.checkApply(summary, identities, sender, existing);
    if (!check.ok || !existing) throw new ForbiddenException('This message cannot change your calendar');

    if (summary.method === 'REPLY') {
      const answer = summary.attendees[0]!;
      await jmapCall(jmap, 'CalendarEvent/set', {
        update: { [existing.id]: { [`participants/${check.participantKey}/participationStatus`]: answer.status } },
      });
    } else if (summary.recurrenceId) {
      await jmapCall(jmap, 'CalendarEvent/set', {
        update: { [existing.id]: { [`recurrenceOverrides/${summary.recurrenceId.slice(0, 19)}`]: { excluded: true } } },
      });
    } else {
      await jmapCall(jmap, 'CalendarEvent/set', { destroy: [existing.id] });
    }
    const result = await this.find(userId, emailId);
    return { ...result, applied: true, actionable: summary.method === 'REPLY' ? false : result.actionable };
  }

  /** The invitation as a JSCalendar event Cyrus parsed, limited to what is imported. */
  private async importable(jmap: ServerJmap, blobId: string, uid: string): Promise<Record<string, unknown>> {
    const { parsed } = await jmapCall<{ parsed?: Record<string, Record<string, unknown>> | null }>(jmap, 'CalendarEvent/parse', {
      blobIds: [blobId],
    });
    let object = parsed?.[blobId];
    if (object?.['@type'] === 'Group') {
      object = ((object.entries ?? []) as Record<string, unknown>[]).find((e) => e.uid === uid && !e.recurrenceId);
    }
    if (!object || object['@type'] !== 'Event' || object.uid !== uid) throw new UnprocessableEntityException('The invitation cannot be read');
    const event: Record<string, unknown> = {};
    for (const key of IMPORTED) if (object[key] !== undefined && object[key] !== null) event[key] = object[key];
    return event;
  }
}

function findCalendarPart(part: BodyPart | null | undefined, depth = 0): BodyPart | null {
  if (!part || depth > 10) return null;
  if (CALENDAR_TYPES.has(part.type.toLowerCase())) return part;
  for (const sub of part.subParts ?? []) {
    const found = findCalendarPart(sub, depth + 1);
    if (found) return found;
  }
  return null;
}
