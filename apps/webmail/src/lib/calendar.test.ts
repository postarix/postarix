import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventPatch, eventProperties, eventSpan, formatDuration, monthGrid, overlapsDay, parseDuration, toLocalDateTime, usableTimeZone, zonedToDate } from './calendar';

describe('time zones', () => {
  it('converts wall-clock times in a zone to instants and back', () => {
    expect(zonedToDate('2026-11-10T10:00:00', 'America/Bogota').toISOString()).toBe('2026-11-10T15:00:00.000Z');
    expect(zonedToDate('2026-07-01T12:00:00', 'Europe/Madrid').toISOString()).toBe('2026-07-01T10:00:00.000Z');
    expect(zonedToDate('2026-01-15T12:00:00', 'Europe/Madrid').toISOString()).toBe('2026-01-15T11:00:00.000Z');
    expect(toLocalDateTime(new Date('2026-11-10T15:00:00Z'), 'America/Bogota')).toBe('2026-11-10T10:00:00');
  });

  it('handles daylight-saving changes', () => {
    // 2026-03-29 in Madrid: 02:00 → 03:00. 01:30 is CET, 03:30 is CEST.
    expect(zonedToDate('2026-03-29T01:30:00', 'Europe/Madrid').toISOString()).toBe('2026-03-29T00:30:00.000Z');
    expect(zonedToDate('2026-03-29T03:30:00', 'Europe/Madrid').toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });
});

describe('durations', () => {
  it('parses and formats ISO 8601 durations', () => {
    expect(parseDuration('PT1H30M')).toBe(90 * 60_000);
    expect(parseDuration('P1D')).toBe(86_400_000);
    expect(parseDuration('P1W')).toBe(7 * 86_400_000);
    expect(parseDuration('nonsense')).toBe(0);
    expect(formatDuration(90 * 60_000, false)).toBe('PT1H30M');
    expect(formatDuration(60 * 60_000, false)).toBe('PT1H');
    expect(formatDuration(0, false)).toBe('PT0M');
    expect(formatDuration(2 * 86_400_000, true)).toBe('P2D');
  });
});

describe('month grid', () => {
  it('covers full Monday-first weeks', () => {
    const days = monthGrid(2026, 10); // November 2026 starts on a Sunday
    expect(days[0]!.getDate()).toBe(26); // Monday 26 October
    expect(days.length % 7).toBe(0);
    expect(days.some((d) => d.getMonth() === 10 && d.getDate() === 30)).toBe(true);
  });
});

describe('events', () => {
  it('spans and day overlap, all-day included', () => {
    const allDay = eventSpan({ start: '2026-11-10T00:00:00', showWithoutTime: true, duration: 'P2D' });
    expect(overlapsDay(allDay, new Date(2026, 10, 10))).toBe(true);
    expect(overlapsDay(allDay, new Date(2026, 10, 11))).toBe(true);
    expect(overlapsDay(allDay, new Date(2026, 10, 12))).toBe(false);
  });

  it('builds JSCalendar properties for timed and all-day events', () => {
    const timed = eventProperties({
      calendarId: 'Default', title: ' Kickoff ', description: '', location: 'Room 1', allDay: false,
      start: '2026-11-10T10:00', end: '2026-11-10T11:30', repeat: 'weekly',
    });
    expect(timed).toMatchObject({
      title: 'Kickoff', start: '2026-11-10T10:00:00', duration: 'PT1H30M', showWithoutTime: false,
      locations: { l1: { name: 'Room 1' } }, recurrenceRules: [{ frequency: 'weekly' }],
    });
    const allDay = eventProperties({
      calendarId: 'Default', title: 'Trip', description: '', location: '', allDay: true,
      start: '2026-11-10T00:00', end: '2026-11-12T00:00', repeat: 'none',
    });
    expect(allDay).toMatchObject({ start: '2026-11-10T00:00:00', duration: 'P3D', timeZone: null, showWithoutTime: true, recurrenceRules: null });
  });
});

describe('around daylight-saving changes (Europe/Berlin)', () => {
  const saved = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Europe/Berlin';
  });
  afterAll(() => {
    process.env.TZ = saved;
  });

  it('keeps a one-day all-day event on its own day', () => {
    // 29 March 2026 has 23 hours in Berlin.
    const span = eventSpan({ start: '2026-03-29T00:00:00', duration: 'P1D', showWithoutTime: true, timeZone: null });
    expect(overlapsDay(span, new Date(2026, 2, 29))).toBe(true);
    expect(overlapsDay(span, new Date(2026, 2, 30))).toBe(false);
  });

  it('counts the days of an all-day event on the calendar', () => {
    const props = eventProperties({ calendarId: 'c', title: 'Trip', description: '', location: '', allDay: true, start: '2026-10-24T00:00', end: '2026-10-26T00:00', repeat: 'none' });
    expect(props.duration).toBe('P3D');
    const span = eventSpan({ start: '2026-10-24T00:00:00', duration: 'P3D', showWithoutTime: true, timeZone: null });
    expect(span.end).toEqual(new Date(2026, 9, 27));
  });
});

describe('time zones the browser does not know', () => {
  it('shows the event in local time instead of failing', () => {
    expect(usableTimeZone('/Custom/W. Europe')).toBeUndefined();
    expect(usableTimeZone('Europe/Madrid')).toBe('Europe/Madrid');
    expect(() => eventSpan({ start: '2026-11-10T10:00:00', duration: 'PT1H', timeZone: '/Custom/W. Europe', showWithoutTime: false })).not.toThrow();
  });
});

describe('editing an event', () => {
  const original = {
    id: 'e1',
    calendarIds: { c: true },
    title: 'Board meeting',
    start: '2026-11-10T10:00:00',
    timeZone: 'Asia/Tokyo',
    duration: 'PT1H',
    locations: { a: { '@type': 'Location' as const, name: 'Room 1' }, b: { '@type': 'Location' as const, name: 'https://meet.example/x' } },
  };
  const before = { calendarId: 'c', title: 'Board meeting', description: '', location: 'Room 1', allDay: false, start: '2026-11-10T02:00', end: '2026-11-10T03:00', repeat: 'none' as const };

  it('sends only what changed and keeps the other locations and the time zone', () => {
    expect(eventPatch(original, before, { ...before, title: 'Board' }, false)).toEqual({ title: 'Board' });
    expect(eventPatch(original, before, { ...before, location: 'Room 2' }, false)).toEqual({ 'locations/a/name': 'Room 2' });
    expect(eventPatch(original, before, { ...before, location: '' }, false)).toEqual({ 'locations/a': null });
    expect(eventPatch(original, before, before, false)).toEqual({});
  });

  it('changes the times only when they were edited, and never for a series edited from one occurrence', () => {
    const moved = { ...before, start: '2026-11-10T04:00', end: '2026-11-10T05:00' };
    expect(Object.keys(eventPatch(original, before, moved, false)).sort()).toEqual(['duration', 'showWithoutTime', 'start', 'timeZone']);
    expect(eventPatch(original, before, moved, true)).toEqual({});
  });
});
