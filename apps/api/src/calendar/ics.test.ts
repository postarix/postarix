import { describe, expect, it } from 'vitest';
import { buildReply, calAddress, IcsError, readItip, replyAttendee, withMethod } from './ics.js';

const EVENT = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//CyrusIMAP.org/Cyrus 3.10.2//EN',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Madrid',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'DTSTART:19961027T030000',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'DTSTART:19810329T020000',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:abc123',
  'SEQUENCE:2',
  'DTSTAMP:20261102T145411Z',
  'DTSTART;TZID=Europe/Madrid:20261120T090000',
  'DURATION:PT30M',
  'SUMMARY:Planning',
  'LOCATION:Room 4',
  'ORGANIZER;CN=Ann:mailto:Ann@Example.com',
  'ATTENDEE;PARTSTAT=ACCEPTED:mailto:ann@example.com',
  'ATTENDEE;CN=Ben;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ben@example.org',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

describe('iCalendar messages', () => {
  it('reads an invitation', () => {
    const summary = readItip(withMethod(EVENT, 'REQUEST'));
    expect(summary).toMatchObject({
      method: 'REQUEST',
      uid: 'abc123',
      sequence: 2,
      title: 'Planning',
      location: 'Room 4',
      start: '2026-11-20T08:00:00.000Z',
      end: '2026-11-20T08:30:00.000Z',
      allDay: false,
      repeats: false,
      organizer: { email: 'ann@example.com', name: 'Ann' },
    });
    expect(summary.attendees).toEqual([
      { email: 'ann@example.com', name: null, status: 'accepted' },
      { email: 'ben@example.org', name: 'Ben', status: 'needs-action' },
    ]);
  });

  it('refuses calendars without a method it handles', () => {
    expect(() => readItip(EVENT)).toThrow(IcsError);
    expect(() => readItip('not a calendar')).toThrow(IcsError);
    expect(() => readItip(withMethod(EVENT, 'REQUEST').replace('UID:abc123\r\n', ''))).toThrow(IcsError);
  });

  it('marks cancellations and bumps the sequence', () => {
    const cancel = withMethod(EVENT, 'CANCEL');
    expect(cancel).toContain('METHOD:CANCEL');
    expect(cancel).toContain('STATUS:CANCELLED');
    expect(readItip(cancel).sequence).toBe(3);
  });

  it('builds a reply with only the answering attendee', () => {
    const reply = buildReply(withMethod(EVENT, 'REQUEST'), 'ben@example.org', 'tentative');
    const summary = readItip(reply);
    expect(summary).toMatchObject({ method: 'REPLY', uid: 'abc123', sequence: 2, start: '2026-11-20T08:00:00.000Z' });
    expect(summary.attendees).toEqual([{ email: 'ben@example.org', name: 'Ben', status: 'tentative' }]);
    expect(replyAttendee(reply)).toEqual({ email: 'ben@example.org', status: 'tentative' });
    expect(reply).toContain('BEGIN:VTIMEZONE');
  });

  it('reads all-day events as dates', () => {
    const allDay = withMethod(EVENT, 'REQUEST')
      .replace('DTSTART;TZID=Europe/Madrid:20261120T090000', 'DTSTART;VALUE=DATE:20261120')
      .replace('DURATION:PT30M', 'DTEND;VALUE=DATE:20261121');
    expect(readItip(allDay)).toMatchObject({ allDay: true, start: '2026-11-20T00:00:00.000Z', end: '2026-11-21T00:00:00.000Z' });
  });

  it('normalizes calendar addresses', () => {
    expect(calAddress('MAILTO:Ben@Example.org')).toBe('ben@example.org');
    expect(calAddress('urn:uuid:123')).toBeNull();
    expect(calAddress(undefined)).toBeNull();
  });

  it('never expands time zone rules of untrusted calendars (they can be made endless)', () => {
    const hostile = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'METHOD:REQUEST',
      'BEGIN:VTIMEZONE',
      'TZID:Evil',
      'BEGIN:STANDARD',
      'DTSTART:16010101T000000',
      'RRULE:FREQ=SECONDLY',
      'TZOFFSETFROM:+0000',
      'TZOFFSETTO:+0300',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:evil',
      'DTSTAMP:20261102T100000Z',
      'DTSTART;TZID=Evil:20261120T090000',
      'DTEND;TZID=Evil:20261120T100000',
      'SUMMARY:Hostile',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const started = Date.now();
    expect(() => readItip(hostile)).toThrow(/unusual rules/);
    expect(Date.now() - started).toBeLessThan(1000);
    // A zone the runtime does not know uses the fixed offset it declares, without expanding anything.
    const windows = hostile.replace('RRULE:FREQ=SECONDLY', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU');
    expect(readItip(windows)).toMatchObject({ start: '2026-11-20T06:00:00.000Z', end: '2026-11-20T07:00:00.000Z' });
    expect(() => buildReply(hostile, 'x@example.org', 'accepted')).not.toThrow();
    expect(() => readItip(windows.replace('SUMMARY:Hostile', 'RRULE:FREQ=MINUTELY'))).toThrow(/more often than daily/);
  });

  it('converts IANA zones across daylight saving time', () => {
    const summer = withMethod(EVENT, 'REQUEST').replace('DTSTART;TZID=Europe/Madrid:20261120T090000', 'DTSTART;TZID=Europe/Madrid:20260720T090000');
    expect(readItip(summer)).toMatchObject({ start: '2026-07-20T07:00:00.000Z', end: '2026-07-20T07:30:00.000Z' });
  });
});
