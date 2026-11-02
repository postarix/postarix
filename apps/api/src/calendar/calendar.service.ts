import { randomUUID } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { type CollectionKind, type MailEngine, MailEngineError, type ShareAccess } from '@postarix/mail-engine';
import { z } from 'zod';
import { MAIL_ENGINE } from '../core/tokens.js';
import { ServerJmap } from '../mail/jmap-client.js';
import { SendService } from '../mail/send.service.js';
import {
  defaultCalendarId,
  describeWhen,
  downloadText,
  findByUid,
  getEvent,
  jmapCall,
  organizerOf,
  type Participant,
  participantEmail,
  type StoredEvent,
} from './calendar-jmap.js';
import { ColleaguesRepository, type OwnMailbox, type Resource } from './colleagues.repository.js';
import { withMethod } from './ics.js';

export const MAX_GUESTS = 50;

/** What a booked resource's calendar keeps of the event. */
const RESOURCE_COPY = [
  'title',
  'start',
  'timeZone',
  'duration',
  'showWithoutTime',
  'recurrenceRules',
  'excludedRecurrenceRules',
  'recurrenceOverrides',
  'locations',
  'participants',
  'replyTo',
  'sequence',
];
export const MAX_SHARES = 50;
export const MAX_AVAILABILITY_PEOPLE = 20;
export const MAX_AVAILABILITY_DAYS = 62;

export const guestsSchema = z.strictObject({
  guests: z.array(z.email().max(254)).max(MAX_GUESTS),
});

export const availabilityQuerySchema = z.object({
  emails: z
    .string()
    .max(20 * 260)
    .transform((v) => [...new Set(v.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))])
    .pipe(z.array(z.email()).min(1).max(MAX_AVAILABILITY_PEOPLE)),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});

export const sharesSchema = z.strictObject({
  shares: z
    .array(z.strictObject({ email: z.email().max(254), access: z.enum(['read', 'write']) }))
    .max(MAX_SHARES),
});

export const collectionKindSchema = z.enum(['calendars', 'address-books']);
export const collectionIdSchema = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/);
export const eventIdSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/);

export interface Guest {
  email: string;
  name: string | null;
  status: string;
}

export interface Busy {
  start: string;
  end: string;
}

export interface Availability {
  email: string;
  busy: Busy[];
}

export interface Share {
  email: string;
  access: ShareAccess;
}

export interface SharedCollection {
  id: string;
  name: string;
  shares: Share[];
}

const EVENT_PROPERTIES = [
  'title',
  'start',
  'timeZone',
  'duration',
  'showWithoutTime',
  'utcStart',
  'utcEnd',
  'sequence',
  'replyTo',
  'participants',
];

/**
 * The organizer side of invitations (iTIP over email, RFC 6047), free/busy
 * within the organization, and sharing calendars and contacts with
 * colleagues. Cyrus never sends calendar mail itself (scheduling is off):
 * everything goes through here, from the person's own address, under their
 * sending limits.
 */
@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(
    @Inject(MAIL_ENGINE) private readonly engine: MailEngine,
    @Inject(ColleaguesRepository) private readonly colleagues: ColleaguesRepository,
    @Inject(SendService) private readonly sender: SendService,
  ) {}

  private async me(userId: string): Promise<OwnMailbox> {
    const own = await this.colleagues.own(userId);
    if (!own) throw new NotFoundException('You have no mailbox');
    return own;
  }

  /**
   * Sets who is invited to one of the person's events and emails them the
   * invitation (or the update). People taken off the list get a cancellation.
   */
  async setGuests(userId: string, eventId: string, requested: string[]): Promise<{ guests: Guest[]; notified: number }> {
    const me = await this.me(userId);
    const jmap = new ServerJmap(this.engine, me.address);
    const event = await getEvent(jmap, eventId, EVENT_PROPERTIES);
    const organizer = organizerOf(event);
    if (organizer && organizer !== me.address) throw new ForbiddenException('Only the organizer can change who is invited');

    const guests = [...new Set(requested.map((g) => g.trim().toLowerCase()))].filter((g) => g !== me.address);
    const current = Object.entries(event.participants ?? {}).filter(([, p]) => participantEmail(p) !== me.address);
    const currentEmails = new Set(current.map(([, p]) => participantEmail(p)));
    const removed = current.map(([, p]) => participantEmail(p)!).filter((e) => e && !guests.includes(e));
    if (guests.length === 0 && current.length === 0) return { guests: [], notified: 0 };

    // Rooms and equipment of the organization answer by themselves: booked
    // when free at that time, declined otherwise. They get no email.
    const resources = new Map((await this.colleagues.resources(me.organizationId, [...guests, ...removed])).map((r) => [r.email, r]));
    const booked = new Map<string, boolean>();
    for (const email of guests.filter((g) => resources.has(g))) {
      booked.set(email, await this.isFree(email, event.uid, event.utcStart, event.utcEnd));
    }
    const people = guests.filter((g) => !resources.has(g));
    const removedPeople = removed.filter((g) => !resources.has(g));

    // The event as the removed guests knew it, for their cancellation.
    const removedIcs = removedPeople.length ? await this.ics(jmap, eventId) : null;

    let participants: Record<string, Participant> | null = null;
    if (guests.length) {
      const ownerKey = Object.entries(event.participants ?? {}).find(([, p]) => participantEmail(p) === me.address)?.[0] ?? 'organizer';
      participants = {
        [ownerKey]: {
          '@type': 'Participant',
          email: me.address,
          sendTo: { imip: `mailto:${me.address}` },
          roles: { owner: true, attendee: true },
          participationStatus: 'accepted',
          expectReply: false,
        },
      };
      for (const email of guests) {
        const existing = current.find(([, p]) => participantEmail(p) === email);
        const resource = resources.get(email);
        participants[existing?.[0] ?? randomUUID().replaceAll('-', '').slice(0, 16)] = resource
          ? {
              '@type': 'Participant',
              email,
              name: resource.name,
              sendTo: { imip: `mailto:${email}` },
              kind: resource.kind === 'room' ? 'location' : 'resource',
              roles: { attendee: true },
              participationStatus: booked.get(email) ? 'accepted' : 'declined',
              expectReply: false,
            }
          : {
              '@type': 'Participant',
              email,
              sendTo: { imip: `mailto:${email}` },
              roles: { attendee: true },
              participationStatus: existing?.[1].participationStatus ?? 'needs-action',
              expectReply: true,
              ...(existing?.[1].name ? { name: existing[1].name } : {}),
            };
      }
    }
    const sequence = (event.sequence ?? 0) + (current.length ? 1 : 0);
    const patch = participants
      ? { participants, replyTo: { imip: `mailto:${me.address}` }, sequence }
      : { participants: null, replyTo: null, sequence };
    const result = await jmapCall<{ notUpdated?: Record<string, { type: string; description?: string }> | null }>(jmap, 'CalendarEvent/set', {
      update: { [eventId]: patch },
    });
    const failure = result.notUpdated?.[eventId];
    if (failure) throw new UnprocessableEntityException(`Could not update the event: ${failure.description ?? failure.type}`);

    const updated = await getEvent(jmap, eventId, [...EVENT_PROPERTIES, 'blobId']);
    const title = updated.title || '(no title)';
    const when = describeWhen(updated);
    // The booked resources' calendars hold the event too; the others don't.
    for (const email of resources.keys()) {
      await this.syncResource(email, eventId, jmap, booked.get(email) === true);
    }

    let notified = 0;
    if (people.length) {
      const ics = withMethod(await downloadText(jmap, updated.blobId!), 'REQUEST');
      const update = people.some((g) => currentEmails.has(g));
      await this.sender.sendComposed(userId, {
        from: me.address,
        to: people,
        subject: `${update ? 'Updated invitation' : 'Invitation'}: ${title}`,
        text: `${me.address} invites you to "${title}".\n\nWhen: ${when}\n\nAnswer from your calendar or mail app.\n`,
        calendar: { method: 'REQUEST', content: ics },
      });
      notified += people.length;
    }
    if (removedIcs && removedPeople.length) {
      await this.sender.sendComposed(userId, {
        from: me.address,
        to: removedPeople,
        subject: `Cancelled: ${title}`,
        text: `${me.address} took you off "${title}".\n\nWhen: ${when}\n`,
        calendar: { method: 'CANCEL', content: withMethod(removedIcs, 'CANCEL') },
      });
      notified += removedPeople.length;
    }
    return { guests: this.guestsOf(updated, me.address), notified };
  }

  /** Deletes one of the person's events, telling its guests it is cancelled. */
  async cancel(userId: string, eventId: string): Promise<{ notified: number }> {
    const me = await this.me(userId);
    const jmap = new ServerJmap(this.engine, me.address);
    const event = await getEvent(jmap, eventId, [...EVENT_PROPERTIES, 'blobId']);
    const organizer = organizerOf(event);
    const everyone = organizer === me.address ? this.guestsOf(event, me.address).map((g) => g.email) : [];
    const resources = new Set((await this.colleagues.resources(me.organizationId, everyone)).map((r) => r.email));
    const guests = everyone.filter((g) => !resources.has(g));
    const ics = guests.length ? await downloadText(jmap, event.blobId!) : null;
    // Free the booked rooms and equipment.
    for (const email of resources) await this.syncResource(email, eventId, jmap, false, event.uid);

    const result = await jmapCall<{ notDestroyed?: Record<string, { type: string }> | null }>(jmap, 'CalendarEvent/set', { destroy: [eventId] });
    if (result.notDestroyed?.[eventId]) throw new UnprocessableEntityException(`Could not delete the event: ${result.notDestroyed[eventId]!.type}`);
    if (!ics) return { notified: 0 };
    const title = event.title || '(no title)';
    await this.sender.sendComposed(userId, {
      from: me.address,
      to: guests,
      subject: `Cancelled: ${title}`,
      text: `${me.address} cancelled "${title}".\n\nWhen: ${describeWhen(event)}\n`,
      calendar: { method: 'CANCEL', content: withMethod(ics, 'CANCEL') },
    });
    return { notified: guests.length };
  }

  /**
   * When colleagues are busy: times only, never what the events are. People
   * outside the person's organization (or unknown addresses) get no answer,
   * the same either way.
   */
  async availability(userId: string, emails: string[], from: Date, to: Date): Promise<{ data: Availability[]; unavailable: string[] }> {
    if (!(to > from)) throw new UnprocessableEntityException('"to" must be after "from"');
    if (to.getTime() - from.getTime() > MAX_AVAILABILITY_DAYS * 24 * 3600 * 1000) {
      throw new UnprocessableEntityException(`Ask for at most ${MAX_AVAILABILITY_DAYS} days at a time`);
    }
    const me = await this.me(userId);
    const known = await this.colleagues.inOrganization(me.organizationId, emails);
    const data: Availability[] = [];
    const unavailable: string[] = [];
    for (const email of emails) {
      if (!known.has(email)) {
        unavailable.push(email);
        continue;
      }
      try {
        data.push({ email, busy: await this.busyTimes(email, from, to) });
      } catch (error) {
        this.logger.warn(`Free/busy of ${email} failed: ${error instanceof Error ? error.message : String(error)}`);
        unavailable.push(email);
      }
    }
    return { data, unavailable };
  }

  /** The organization's rooms and equipment, for the person to book. */
  async listResources(userId: string): Promise<Resource[]> {
    const me = await this.me(userId);
    return this.colleagues.resources(me.organizationId);
  }

  /**
   * Whether a resource is free for an event (its first occurrence, for a
   * repeating one), not counting that event itself.
   */
  private async isFree(email: string, uid: string, start: string | undefined, end: string | undefined): Promise<boolean> {
    if (!start || !end) return false;
    const busy = await this.busyTimes(email, new Date(start), new Date(end), uid);
    return busy.length === 0;
  }

  /** Puts the organizer's event into a resource's calendar (or takes it out). */
  private async syncResource(email: string, eventId: string, organizer: ServerJmap, booked: boolean, knownUid?: string): Promise<void> {
    const room = new ServerJmap(this.engine, email);
    try {
      const source = booked ? await getEvent(organizer, eventId, RESOURCE_COPY) : null;
      const uid = source?.uid ?? knownUid ?? (await getEvent(organizer, eventId, [])).uid;
      const copy = await findByUid(room, uid, []);
      if (!source) {
        if (copy) await jmapCall(room, 'CalendarEvent/set', { destroy: [copy.id] });
        return;
      }
      const fields: Record<string, unknown> = {};
      for (const key of RESOURCE_COPY) {
        const value = (source as unknown as Record<string, unknown>)[key];
        if (value !== undefined) fields[key] = value;
      }
      if (copy) {
        await jmapCall(room, 'CalendarEvent/set', { update: { [copy.id]: fields } });
      } else {
        const calendarId = await defaultCalendarId(room);
        await jmapCall(room, 'CalendarEvent/set', { create: { booking: { ...fields, uid, calendarIds: { [calendarId]: true } } } });
      }
    } catch (error) {
      this.logger.warn(`Could not update the calendar of ${email}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async busyTimes(email: string, from: Date, to: Date, excludeUid?: string): Promise<Busy[]> {
    const jmap = new ServerJmap(this.engine, email);
    const { list: calendars } = await jmapCall<{ list: { id: string; includeInAvailability?: string | null }[] }>(jmap, 'Calendar/get', {
      properties: ['id', 'includeInAvailability'],
    });
    const counted = new Set(calendars.filter((c) => c.includeInAvailability !== 'none').map((c) => c.id));
    if (!counted.size) return [];
    const utc = (d: Date) => d.toISOString().slice(0, 19);
    const { ids } = await jmapCall<{ ids: string[] }>(jmap, 'CalendarEvent/query', {
      filter: { after: utc(from), before: utc(to) },
      expandRecurrences: true,
      limit: 1000,
    });
    if (!ids.length) return [];
    const { list } = await jmapCall<{ list: StoredEvent[] }>(jmap, 'CalendarEvent/get', {
      ids,
      properties: ['uid', 'utcStart', 'utcEnd', 'freeBusyStatus', 'status', 'calendarIds', 'participants'],
    });
    const intervals = list
      .filter((e) => e.utcStart && e.utcEnd && e.freeBusyStatus !== 'free' && e.status !== 'cancelled')
      .filter((e) => !excludeUid || e.uid !== excludeUid)
      .filter((e) => Object.keys(e.calendarIds ?? {}).some((id) => counted.has(id)))
      .filter((e) => {
        const mine = Object.values(e.participants ?? {}).find((p) => participantEmail(p) === email);
        return mine?.participationStatus !== 'declined';
      })
      .map((e) => ({
        start: Math.max(Date.parse(e.utcStart!), from.getTime()),
        end: Math.min(Date.parse(e.utcEnd!), to.getTime()),
      }))
      .filter((i) => i.end > i.start)
      .sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const interval of intervals) {
      const last = merged.at(-1);
      if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
      else merged.push({ ...interval });
    }
    return merged.map((i) => ({ start: new Date(i.start).toISOString(), end: new Date(i.end).toISOString() }));
  }

  /** The person's calendars and contacts, with whom each is shared. */
  async sharing(userId: string): Promise<{ calendars: SharedCollection[]; addressBooks: SharedCollection[] }> {
    const me = await this.me(userId);
    const jmap = new ServerJmap(this.engine, me.address);
    const { list } = await jmapCall<{ list: { id: string; name: string }[] }>(jmap, 'Calendar/get', { properties: ['id', 'name'] });
    const calendars: SharedCollection[] = [];
    for (const calendar of list) {
      calendars.push({ id: calendar.id, name: calendar.name, shares: await this.shares(me.address, 'calendar', calendar.id) });
    }
    const addressBooks = [{ id: 'Default', name: 'Contacts', shares: await this.shares(me.address, 'addressbook', 'Default') }];
    return { calendars, addressBooks };
  }

  private async shares(address: string, kind: CollectionKind, id: string): Promise<Share[]> {
    try {
      return (await this.engine.listShares(address, kind, id)).map((s) => ({ email: s.grantee, access: s.access }));
    } catch (error) {
      if (error instanceof MailEngineError && error.code === 'not_found') return [];
      throw error;
    }
  }

  /**
   * Replaces who a calendar or the address book is shared with. New people
   * must be in the person's organization; people already on the list may stay.
   */
  async setSharing(userId: string, kind: CollectionKind, collectionId: string, wanted: Share[]): Promise<SharedCollection> {
    const me = await this.me(userId);
    const shares = new Map<string, ShareAccess>();
    for (const share of wanted) shares.set(share.email.toLowerCase(), share.access);
    if (shares.has(me.address)) throw new UnprocessableEntityException('You already have this calendar');

    let name = 'Contacts';
    if (kind === 'calendar') {
      const jmap = new ServerJmap(this.engine, me.address);
      const { list } = await jmapCall<{ list: { id: string; name: string }[] }>(jmap, 'Calendar/get', {
        ids: [collectionId],
        properties: ['id', 'name'],
      });
      if (!list[0]) throw new NotFoundException('Calendar not found');
      name = list[0].name;
    } else if (collectionId !== 'Default') {
      throw new NotFoundException('Address book not found');
    }

    // Everyone on the list must still be a colleague (people who left are dropped).
    const existing = new Set((await this.shares(me.address, kind, collectionId)).map((s) => s.email));
    const colleagues = await this.colleagues.inOrganization(me.organizationId, [...shares.keys()]);
    const outsider = [...shares.keys()].find((e) => !colleagues.has(e) && !existing.has(e));
    if (outsider) throw new UnprocessableEntityException(`${outsider} is not in your organization`);
    for (const email of [...shares.keys()]) if (!colleagues.has(email)) shares.delete(email);

    try {
      await this.engine.setShares(
        me.address,
        kind,
        collectionId,
        [...shares].map(([grantee, access]) => ({ grantee, access })),
      );
    } catch (error) {
      if (error instanceof MailEngineError && error.code === 'not_found') throw new NotFoundException('Not found');
      throw error;
    }
    return { id: collectionId, name, shares: await this.shares(me.address, kind, collectionId) };
  }

  private guestsOf(event: StoredEvent, organizer: string): Guest[] {
    return Object.values(event.participants ?? {})
      .map((p) => ({ email: participantEmail(p) ?? '', name: p.name ?? null, status: p.participationStatus ?? 'needs-action' }))
      .filter((g) => g.email && g.email !== organizer);
  }

  private async ics(jmap: ServerJmap, eventId: string): Promise<string> {
    const event = await getEvent(jmap, eventId, ['blobId']);
    return downloadText(jmap, event.blobId!);
  }
}
