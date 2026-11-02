import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { MailEngine } from '@postarix/mail-engine';
import { z } from 'zod';
import { MAIL_ENGINE } from '../core/tokens.js';
import { ServerJmap } from '../mail/jmap-client.js';
import { defaultCalendarId, jmapCall } from './calendar-jmap.js';
import { ColleaguesRepository } from './colleagues.repository.js';
import { checkImport, IcsError } from './ics.js';
import { type ImportedContact, readVcards, VcardError } from './vcard.js';

export const importQuerySchema = z.object({
  calendarId: z
    .string()
    .regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/)
    .optional(),
});

export interface ImportResult {
  /** Created. */
  imported: number;
  /** Already there (same event UID, or a contact with the same email address), or refused by the mail server. */
  skipped: number;
}

/**
 * Event properties kept from an imported calendar. Guests and organizer are
 * left out: an imported event is the person's own copy, and must not send
 * invitations or answers on anyone's behalf.
 */
const IMPORTED_EVENT = [
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
  'status',
  'freeBusyStatus',
  'privacy',
  'color',
  'keywords',
];
/** Within an occurrence override, the same minus the event's identity. */
const OVERRIDE_KEYS = new Set([...IMPORTED_EVENT.filter((k) => k !== 'uid' && !k.startsWith('recurrence') && k !== 'excludedRecurrenceRules'), 'excluded']);
const BATCH = 100;

/**
 * Imports another service's exports into the signed-in person's own calendar
 * (.ics) and contacts (.vcf), as when moving from Google or Microsoft 365.
 * Data already there is skipped, so importing the same file twice is safe.
 */
@Injectable()
export class ImportService {
  constructor(
    @Inject(MAIL_ENGINE) private readonly engine: MailEngine,
    @Inject(ColleaguesRepository)
    private readonly colleagues: ColleaguesRepository,
  ) {}

  private async jmap(userId: string): Promise<ServerJmap> {
    const own = await this.colleagues.own(userId);
    if (!own) throw new NotFoundException('You have no mailbox');
    return new ServerJmap(this.engine, own.address);
  }

  async importCalendar(userId: string, ics: string, calendarId?: string): Promise<ImportResult> {
    try {
      checkImport(ics);
    } catch (error) {
      if (error instanceof IcsError) throw new UnprocessableEntityException(error.message);
      throw error;
    }
    const jmap = await this.jmap(userId);
    const target = calendarId ?? (await defaultCalendarId(jmap));
    if (calendarId) {
      const { list } = await jmapCall<{
        list: { id: string; myRights?: { mayWriteAll?: boolean } }[];
      }>(jmap, 'Calendar/get', {
        ids: [calendarId],
        properties: ['id', 'myRights'],
      });
      if (!list[0] || list[0].myRights?.mayWriteAll === false) throw new NotFoundException('Calendar not found');
    }

    // The mail server reads the file (time zones, repeat rules) into JSCalendar.
    const blobId = await jmap.upload(new TextEncoder().encode(ics), 'text/calendar');
    const { parsed } = await jmapCall<{
      parsed?: Record<string, Record<string, unknown>> | null;
    }>(jmap, 'CalendarEvent/parse', { blobIds: [blobId] });
    const object = parsed?.[blobId];
    if (!object) throw new UnprocessableEntityException('The calendar data cannot be read');
    const entries = (object['@type'] === 'Group' ? (object.entries ?? []) : [object]) as Record<string, unknown>[];
    // Occurrences changed on their own arrive with their event in recurrenceOverrides.
    const events = entries.filter((e) => e['@type'] === 'Event' && typeof e.uid === 'string' && !e.recurrenceId).map(eventToImport);

    let imported = 0;
    for (let i = 0; i < events.length; i += BATCH) {
      const create = Object.fromEntries(events.slice(i, i + BATCH).map((event, j) => [`e${j}`, { ...event, calendarIds: { [target]: true } }]));
      const { created } = await jmapCall<{
        created?: Record<string, unknown> | null;
      }>(jmap, 'CalendarEvent/set', { create });
      imported += Object.keys(created ?? {}).length;
    }
    return { imported, skipped: entries.length - imported };
  }

  async importContacts(userId: string, vcf: string): Promise<ImportResult> {
    let contacts: ImportedContact[];
    try {
      contacts = readVcards(vcf);
    } catch (error) {
      if (error instanceof VcardError) throw new UnprocessableEntityException(error.message);
      throw error;
    }
    const jmap = await this.jmap(userId);
    // Skip people already in the address book (by email address), and duplicates within the file.
    const { ids } = await jmapCall<{ ids: string[] }>(jmap, 'Contact/query', {
      limit: 10_000,
    });
    const known = new Set<string>();
    for (let i = 0; i < ids.length; i += 1000) {
      const { list } = await jmapCall<{
        list: { emails?: { value?: string }[] }[];
      }>(jmap, 'Contact/get', {
        ids: ids.slice(i, i + 1000),
        properties: ['emails'],
      });
      for (const contact of list) for (const email of contact.emails ?? []) if (email.value) known.add(email.value.toLowerCase());
    }
    const fresh = contacts.filter((contact) => {
      const addresses = contact.emails.map((e) => e.value.toLowerCase());
      if (addresses.some((a) => known.has(a))) return false;
      for (const a of addresses) known.add(a);
      return true;
    });

    let imported = 0;
    for (let i = 0; i < fresh.length; i += BATCH) {
      const create = Object.fromEntries(fresh.slice(i, i + BATCH).map((contact, j) => [`c${j}`, contact]));
      const { created } = await jmapCall<{
        created?: Record<string, unknown> | null;
      }>(jmap, 'Contact/set', { create });
      imported += Object.keys(created ?? {}).length;
    }
    return { imported, skipped: contacts.length - imported };
  }
}

function eventToImport(entry: Record<string, unknown>): Record<string, unknown> {
  const event: Record<string, unknown> = { '@type': 'Event' };
  for (const key of IMPORTED_EVENT) if (entry[key] !== undefined && entry[key] !== null) event[key] = entry[key];
  const overrides = entry.recurrenceOverrides;
  if (overrides && typeof overrides === 'object') {
    event.recurrenceOverrides = Object.fromEntries(
      Object.entries(overrides as Record<string, Record<string, unknown>>).map(([at, patch]) => [
        at,
        Object.fromEntries(Object.entries(patch ?? {}).filter(([key]) => OVERRIDE_KEYS.has(key.split('/')[0]!))),
      ]),
    );
  }
  return event;
}
