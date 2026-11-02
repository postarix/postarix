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

function utc(time: ICAL.Time | null): string | null {
  if (!time) return null;
  try {
    return time.toJSDate().toISOString();
  } catch {
    return null;
  }
}

/** Reads an iMIP calendar part. Throws IcsError for anything Postarix does not handle. */
export function readItip(ics: string): ItipSummary {
  const root = parse(ics);
  const method = String(root.getFirstPropertyValue('method') ?? '').toUpperCase();
  if (method !== 'REQUEST' && method !== 'REPLY' && method !== 'CANCEL') throw new IcsError('Unsupported calendar message');
  const event = mainEvent(root);
  const uid = textOf(event, 'uid');
  if (!uid || uid.length > 255) throw new IcsError('The event has no valid UID');

  const start = timeOf(event, 'dtstart');
  let endTime = timeOf(event, 'dtend');
  if (!endTime && start) {
    const duration = event.getFirstPropertyValue('duration');
    if (duration instanceof ICAL.Duration) {
      endTime = start.clone();
      endTime.addDuration(duration);
    }
  }
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
  const allDay = start?.isDate ?? false;

  return {
    method,
    uid,
    sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0,
    recurrenceId: recurrenceId ? recurrenceId.toString() : null,
    title: textOf(event, 'summary') ?? '',
    location: textOf(event, 'location'),
    start: allDay ? (start ? `${start.toString()}T00:00:00.000Z` : null) : utc(start),
    end: allDay ? (endTime ? `${endTime.toString()}T00:00:00.000Z` : null) : utc(endTime),
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
