import { NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { BlobTooLargeError, JmapMethodError, type ServerJmap } from '../mail/jmap-client.js';

/** A JSCalendar participant (RFC 8984 §4.4.6), as Cyrus returns it. */
export interface Participant {
  '@type'?: 'Participant';
  name?: string | null;
  email?: string | null;
  sendTo?: Record<string, string> | null;
  roles?: Record<string, boolean> | null;
  participationStatus?: string | null;
  expectReply?: boolean | null;
}

export interface StoredEvent {
  id: string;
  uid: string;
  title?: string | null;
  description?: string | null;
  start?: string;
  timeZone?: string | null;
  duration?: string | null;
  showWithoutTime?: boolean | null;
  utcStart?: string;
  utcEnd?: string;
  sequence?: number | null;
  replyTo?: Record<string, string> | null;
  participants?: Record<string, Participant> | null;
  recurrenceRules?: unknown[] | null;
  blobId?: string;
  calendarIds?: Record<string, boolean>;
  freeBusyStatus?: string | null;
  status?: string | null;
}

/** Largest calendar object handled (invitations, stored events). */
export const MAX_ICS_BYTES = 256 * 1024;

export async function jmapCall<T extends Record<string, unknown>>(jmap: ServerJmap, name: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await jmap.single<T>(name, args);
  } catch (error) {
    if (error instanceof JmapMethodError) throw new UnprocessableEntityException(`Mail server error: ${error.type}`);
    throw error;
  }
}

export async function getEvent(jmap: ServerJmap, id: string, properties: string[]): Promise<StoredEvent> {
  const { list } = await jmapCall<{ list: StoredEvent[] }>(jmap, 'CalendarEvent/get', { ids: [id], properties: ['uid', ...properties] });
  const event = list[0];
  if (!event) throw new NotFoundException('Event not found');
  return event;
}

/** Events of the account's own calendars with this UID (base events, not occurrences). */
export async function findByUid(jmap: ServerJmap, uid: string, properties: string[]): Promise<StoredEvent | null> {
  const { ids } = await jmapCall<{ ids: string[] }>(jmap, 'CalendarEvent/query', { filter: { uid } });
  if (!ids.length) return null;
  const { list } = await jmapCall<{ list: StoredEvent[] }>(jmap, 'CalendarEvent/get', { ids: ids.slice(0, 1), properties: ['uid', ...properties] });
  return list[0] ?? null;
}

export async function downloadText(jmap: ServerJmap, blobId: string): Promise<string> {
  try {
    return (await jmap.download(blobId, MAX_ICS_BYTES)).toString('utf8');
  } catch (error) {
    if (error instanceof BlobTooLargeError) throw new UnprocessableEntityException('The calendar data is too large');
    throw error;
  }
}

/** The address a calendar user address URI ("mailto:…") points to. */
export function mailto(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^mailto:(.+)$/i.exec(value.trim());
  return match ? match[1]!.trim().toLowerCase() : null;
}

export function participantEmail(p: Participant): string | null {
  return (p.email ?? mailto(p.sendTo?.imip))?.toLowerCase() ?? null;
}

/** The organizer's address: replyTo (RFC 8984 §4.4.4), else the owner participant. */
export function organizerOf(event: Pick<StoredEvent, 'replyTo' | 'participants'>): string | null {
  const replyTo = mailto(event.replyTo?.imip);
  if (replyTo) return replyTo;
  const owner = Object.values(event.participants ?? {}).find((p) => p.roles?.owner);
  return owner ? participantEmail(owner) : null;
}

export async function defaultCalendarId(jmap: ServerJmap): Promise<string> {
  const { list } = await jmapCall<{ list: { id: string; myRights?: { mayWriteAll?: boolean } }[] }>(jmap, 'Calendar/get', {
    properties: ['id', 'myRights'],
  });
  const own = list.filter((c) => c.myRights?.mayWriteAll !== false);
  const calendar = own.find((c) => c.id === 'Default') ?? own[0];
  if (!calendar) throw new ServiceUnavailableException('You have no calendar');
  return calendar.id;
}

/** "Friday, 20 November 2026, 09:00 (Europe/Madrid)", for the text of calendar messages. */
export function describeWhen(event: Pick<StoredEvent, 'utcStart' | 'timeZone' | 'showWithoutTime' | 'start'>): string {
  if (event.showWithoutTime && event.start) {
    const date = new Date(`${event.start.slice(0, 10)}T00:00:00Z`);
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeZone: 'UTC' }).format(date);
  }
  if (!event.utcStart) return '';
  const zone = event.timeZone ?? 'UTC';
  try {
    const text = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: zone }).format(new Date(event.utcStart));
    return `${text} (${zone})`;
  } catch {
    return `${event.utcStart} (UTC)`;
  }
}
