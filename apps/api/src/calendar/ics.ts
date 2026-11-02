import ICAL from 'ical.js';

/** iTIP methods Postarix understands (RFC 5546). */
export type ItipMethod = 'REQUEST' | 'REPLY' | 'CANCEL';
export type ParticipationStatus = 'needs-action' | 'accepted' | 'tentative' | 'declined' | 'delegated';

export interface ItipAttendee {
  email: string;
  name: string | null;
  status: ParticipationStatus;
}

/** What a calendar message (iMIP) says, as shown next to the email. */
export interface ItipSummary {
  method: ItipMethod;
  uid: string;
  sequence: number;
  /** Set when the message is about one occurrence of a repeating event. */
  recurrenceId: string | null;
  title: string;
  location: string | null;
  /** UTC instants; for all-day events, the dates at midnight UTC. */
  start: string | null;
  end: string | null;
  allDay: boolean;
  repeats: boolean;
  organizer: { email: string; name: string | null } | null;
  attendees: ItipAttendee[];
}

export class IcsError extends Error {}

const PRODID = '-//Postarix//Postarix//EN';
const MAX_ATTENDEES = 500;

function parse(ics: string): ICAL.Component {
  let jcal: unknown;
  try {
    jcal = ICAL.parse(ics);
  } catch {
    throw new IcsError('The calendar data cannot be read');
  }
  // ICAL.parse returns several components when the text holds more than one.
  const root = new ICAL.Component((Array.isArray(jcal) && Array.isArray(jcal[0]) ? jcal[0] : jcal) as unknown[]);
  if (root.name !== 'vcalendar') throw new IcsError('Not a calendar');
  return root;
}

/** "mailto:Ann@Example.com" → "ann@example.com"; null for anything that is not an email address. */
export function calAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^mailto:(.+)$/i.exec(value.trim());
  const email = (match ? match[1]! : value).trim().toLowerCase();
  return /^[^\s@<>"]+@[^\s@<>"]+$/.test(email) ? email : null;
}

function partstat(value: unknown): ParticipationStatus {
  const status = String(value ?? 'NEEDS-ACTION').toLowerCase();
  return (['accepted', 'tentative', 'declined', 'delegated'] as const).find((s) => s === status) ?? 'needs-action';
}

function textOf(component: ICAL.Component, name: string): string | null {
  const value = component.getFirstPropertyValue(name);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function events(root: ICAL.Component): ICAL.Component[] {
  return root.getAllSubcomponents('vevent');
}

/** The main event of an iTIP message: the one without RECURRENCE-ID, or the first. */
function mainEvent(root: ICAL.Component): ICAL.Component {
  const all = events(root);
  const event = all.find((e) => !e.hasProperty('recurrence-id')) ?? all[0];
  if (!event) throw new IcsError('The message holds no event');
  return event;
}

function timeOf(component: ICAL.Component, name: string): ICAL.Time | null {
  const value = component.getFirstPropertyValue(name);
  return value instanceof ICAL.Time ? value : null;
}

/**
 * Time zones of untrusted calendar data are never expanded: a VTIMEZONE can
 * hold rules that take forever to compute (RRULE:FREQ=SECONDLY since 1601).
 * Instead, a TZID the runtime knows (IANA names) is converted with Intl;
 * any other one (Windows names from Outlook) uses the fixed offset its
 * VTIMEZONE declares for standard time; floating times count as UTC.
 */
function fixedOffsets(root: ICAL.Component): Map<string, number> {
  const offsets = new Map<string, number>();
  for (const zone of root.getAllSubcomponents('vtimezone').slice(0, 50)) {
    const tzid = zone.getFirstPropertyValue('tzid');
    const part = zone.getFirstSubcomponent('standard') ?? zone.getAllSubcomponents()[0];
    const raw = part?.getFirstProperty('tzoffsetto')?.toICALString() ?? '';
    const match = /([+-])(\d{2}):?(\d{2})\s*$/.exec(raw);
    if (typeof tzid === 'string' && match) {
      offsets.set(tzid, (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])));
    }
  }
  return offsets;
}

const knownZones = new Map<string, boolean>();
function isKnownZone(tzid: string): boolean {
  let known = knownZones.get(tzid);
  if (known === undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tzid });
      known = true;
    } catch {
      known = false;
    }
    if (knownZones.size < 1000) knownZones.set(tzid, known);
  }
  return known;
}

/** The UTC offset of an IANA zone at an instant, in minutes. */
function zoneOffset(tzid: string, at: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  const local = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return Math.round((local - at) / 60_000);
}

/** Wall-clock fields of a date-time as if they were UTC (no zone applied). */
function wallClock(time: ICAL.Time): number {
  return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
}

function instant(prop: ICAL.Property | null, offsets: Map<string, number>, extraSeconds = 0): string | null {
  const time = prop?.getFirstValue();
  if (!(time instanceof ICAL.Time)) return null;
  const wall = wallClock(time) + extraSeconds * 1000;
  if (!Number.isFinite(wall)) return null;
  const tzid = prop!.getParameter('tzid');
  let epoch = wall;
  if (typeof tzid === 'string' && tzid) {
    if (isKnownZone(tzid)) {
      // Two passes settle daylight-saving transitions.
      epoch = wall - zoneOffset(tzid, wall) * 60_000;
      epoch = wall - zoneOffset(tzid, epoch) * 60_000;
    } else {
      epoch = wall - (offsets.get(tzid) ?? 0) * 60_000;
    }
  }
  const date = new Date(epoch);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function durationSeconds(event: ICAL.Component): number | null {
  const duration = event.getFirstPropertyValue('duration');
  if (!(duration instanceof ICAL.Duration)) return null;
  const seconds = duration.toSeconds();
  return Number.isFinite(seconds) && Math.abs(seconds) < 10 * 365 * 86400 ? seconds : null;
}

/**
 * Real time zones change their offsets at most a few times a year. Rules that
 * repeat more often, or very long lists of changes, only make the calendar
 * slow to compute (here, or in the mail server when the event is imported).
 */
function assertSaneTimezones(root: ICAL.Component): void {
  const zones = root.getAllSubcomponents('vtimezone');
  if (zones.length > 20) throw new IcsError('The calendar has too many time zones');
  for (const zone of zones) {
    const parts = zone.getAllSubcomponents();
    if (parts.length > 400) throw new IcsError('A time zone of the calendar is too long');
    for (const part of parts) {
      for (const rule of part.getAllProperties('rrule')) {
        const freq = String((rule.getFirstValue() as { freq?: string } | null)?.freq ?? '').toUpperCase();
        if (freq !== 'YEARLY') throw new IcsError('A time zone of the calendar has unusual rules');
      }
      if (part.getAllProperties('rdate').length > 400) throw new IcsError('A time zone of the calendar is too long');
    }
  }
}

/** Repeat rules Postarix accepts on events: at most daily (as the webmail allows). */
export const ALLOWED_EVENT_FREQUENCIES = new Set(['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY']);

/** Reads an iMIP calendar part. Throws IcsError for anything Postarix does not handle. */
export function readItip(ics: string): ItipSummary {
  const root = parse(ics);
  assertSaneTimezones(root);
  if (events(root).length > 100) throw new IcsError('The calendar has too many events');
  const method = String(root.getFirstPropertyValue('method') ?? '').toUpperCase();
  if (method !== 'REQUEST' && method !== 'REPLY' && method !== 'CANCEL') throw new IcsError('Unsupported calendar message');
  const event = mainEvent(root);
  const uid = textOf(event, 'uid');
  if (!uid || uid.length > 255) throw new IcsError('The event has no valid UID');
  for (const component of events(root)) {
    for (const rule of component.getAllProperties('rrule')) {
      const freq = String((rule.getFirstValue() as { freq?: string } | null)?.freq ?? '').toUpperCase();
      if (!ALLOWED_EVENT_FREQUENCIES.has(freq)) throw new IcsError('The event repeats more often than daily');
    }
  }

  const offsets = fixedOffsets(root);
  const startProp = event.getFirstProperty('dtstart');
  const start = timeOf(event, 'dtstart');
  const endTime = timeOf(event, 'dtend');
  const duration = endTime ? null : durationSeconds(event);
  const allDay = start?.isDate ?? false;
  const dateOnly = (time: ICAL.Time | null, extraDays = 0) =>
    time ? new Date(Date.UTC(time.year, time.month - 1, time.day + extraDays)).toISOString() : null;
  const organizerProp = event.getFirstProperty('organizer');
  const organizerEmail = calAddress(organizerProp?.getFirstValue());
  const attendees = event
    .getAllProperties('attendee')
    .slice(0, MAX_ATTENDEES)
    .flatMap((prop): ItipAttendee[] => {
      const email = calAddress(prop.getFirstValue());
      if (!email) return [];
      const name = prop.getParameter('cn');
      return [{ email, name: typeof name === 'string' && name.trim() ? name.trim() : null, status: partstat(prop.getParameter('partstat')) }];
    });
  const sequence = Number(event.getFirstPropertyValue('sequence') ?? 0);
  const recurrenceId = timeOf(event, 'recurrence-id');

  return {
    method,
    uid,
    sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0,
    recurrenceId: recurrenceId ? recurrenceId.toString() : null,
    title: textOf(event, 'summary') ?? '',
    location: textOf(event, 'location'),
    start: allDay ? dateOnly(start) : instant(startProp, offsets),
    end: allDay
      ? endTime
        ? dateOnly(endTime)
        : duration !== null
          ? dateOnly(start, Math.round(duration / 86400))
          : null
      : endTime
        ? instant(event.getFirstProperty('dtend'), offsets)
        : duration !== null
          ? instant(startProp, offsets, duration)
          : null,
    allDay,
    repeats: event.hasProperty('rrule'),
    organizer: organizerEmail
      ? { email: organizerEmail, name: (organizerProp?.getParameter('cn') as string | undefined)?.trim() || null }
      : null,
    attendees,
  };
}

/** The same calendar with METHOD set (Cyrus stores events without one). */
export function withMethod(ics: string, method: ItipMethod): string {
  const root = parse(ics);
  root.updatePropertyWithValue('method', method);
  if (method === 'CANCEL') {
    for (const event of events(root)) {
      event.updatePropertyWithValue('status', 'CANCELLED');
      const sequence = Number(event.getFirstPropertyValue('sequence') ?? 0);
      event.updatePropertyWithValue('sequence', (Number.isSafeInteger(sequence) ? sequence : 0) + 1);
    }
  }
  for (const event of events(root)) event.updatePropertyWithValue('dtstamp', ICAL.Time.now());
  return root.toString();
}

/**
 * A REPLY to an invitation (RFC 5546 §3.2.3): the event's identity and time,
 * the organizer, and only the replying attendee with their answer.
 */
export function buildReply(requestIcs: string, attendeeEmail: string, status: 'accepted' | 'tentative' | 'declined'): string {
  const request = parse(requestIcs);
  const original = mainEvent(request);
  const reply = new ICAL.Component(['vcalendar', [], []]);
  reply.updatePropertyWithValue('prodid', PRODID);
  reply.updatePropertyWithValue('version', '2.0');
  reply.updatePropertyWithValue('method', 'REPLY');
  for (const timezone of request.getAllSubcomponents('vtimezone')) reply.addSubcomponent(new ICAL.Component(timezone.toJSON()));

  const event = new ICAL.Component('vevent');
  for (const name of ['uid', 'sequence', 'recurrence-id', 'dtstart', 'dtend', 'duration', 'summary', 'organizer']) {
    const prop = original.getFirstProperty(name);
    if (prop) event.addProperty(new ICAL.Property(prop.toJSON()));
  }
  event.updatePropertyWithValue('dtstamp', ICAL.Time.now());
  const mine = original.getAllProperties('attendee').find((p) => calAddress(p.getFirstValue()) === attendeeEmail);
  const attendee = new ICAL.Property('attendee');
  attendee.setValue(`mailto:${attendeeEmail}`);
  const name = mine?.getParameter('cn');
  if (typeof name === 'string' && name) attendee.setParameter('cn', name);
  attendee.setParameter('partstat', status.toUpperCase());
  event.addProperty(attendee);
  reply.addSubcomponent(event);
  return reply.toString();
}

/** The attendee's answer in a REPLY. */
export function replyAttendee(ics: string): { email: string; status: ParticipationStatus } {
  const event = mainEvent(parse(ics));
  const attendees = event.getAllProperties('attendee');
  if (attendees.length !== 1) throw new IcsError('A reply must name exactly one attendee');
  const email = calAddress(attendees[0]!.getFirstValue());
  if (!email) throw new IcsError('The reply names no valid attendee');
  return { email, status: partstat(attendees[0]!.getParameter('partstat')) };
}

/** Most events one calendar file may bring in. */
export const MAX_IMPORTED_EVENTS = 5000;

/**
 * Checks a calendar file someone imports (an .ics export from another
 * service) before the mail server reads it: same limits as invitations, with
 * room for a whole calendar. Returns how many events it holds.
 */
export function checkImport(ics: string): number {
  const root = parse(ics);
  assertSaneTimezones(root);
  const all = events(root);
  if (all.length === 0) throw new IcsError('The file holds no events');
  if (all.length > MAX_IMPORTED_EVENTS) throw new IcsError(`The file holds more than ${MAX_IMPORTED_EVENTS} events`);
  for (const component of all) {
    for (const rule of component.getAllProperties('rrule')) {
      const freq = String((rule.getFirstValue() as { freq?: string } | null)?.freq ?? '').toUpperCase();
      if (!ALLOWED_EVENT_FREQUENCIES.has(freq)) throw new IcsError('An event repeats more often than daily');
    }
  }
  return all.length;
}
