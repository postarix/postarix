import { describe, expect, it } from 'vitest';
import { eventProperties, eventSpan, formatDuration, monthGrid, overlapsDay, parseDuration, toLocalDateTime, zonedToDate } from './calendar';

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
