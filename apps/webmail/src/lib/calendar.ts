import { CAPABILITIES, type Calendar, type CalendarEvent } from '@postarix/jmap-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { jmap } from './jmap';

export const USING_CALENDARS = [CAPABILITIES.core, CAPABILITIES.calendars];

export const userTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

const knownZones = new Map<string, boolean>();
/**
 * The zone if the browser knows it, else undefined (the browser's own zone).
 * JSCalendar also allows custom zones ("/Custom/W. Europe") that Intl rejects;
 * showing such an event in local time beats failing to show the calendar.
 */
export function usableTimeZone(timeZone: string | null | undefined): string | undefined {
  if (!timeZone) return undefined;
  let ok = knownZones.get(timeZone);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone });
      ok = true;
    } catch {
      ok = false;
    }
    knownZones.set(timeZone, ok);
  }
  return ok ? timeZone : undefined;
}

/** "YYYY-MM-DDTHH:MM:SS" of `date` as seen in `timeZone` (or the browser's zone). */
export function toLocalDateTime(date: Date, timeZone?: string | null): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: usableTimeZone(timeZone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function localToEpoch(local: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(local);
  if (!m) throw new Error(`Invalid local date-time: ${local}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
}

/** The instant at which the wall-clock time `local` happens in `timeZone` (floating = the browser's zone). */
export function zonedToDate(local: string, requestedZone?: string | null): Date {
  const timeZone = usableTimeZone(requestedZone);
  if (!timeZone) {
    const epoch = localToEpoch(local);
    const d = new Date(epoch);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  }
  const wanted = localToEpoch(local);
  let guess = wanted;
  // Two passes settle daylight-saving transitions.
  for (let i = 0; i < 2; i++) {
    const seen = localToEpoch(toLocalDateTime(new Date(guess), timeZone));
    guess += wanted - seen;
  }
  return new Date(guess);
}

/** ISO 8601 duration → milliseconds (days and weeks counted as 24 h). */
export function parseDuration(duration: string | undefined): number {
  if (!duration) return 0;
  const m = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration);
  if (!m) return 0;
  const [, minus, w, d, h, min, s] = m;
  const ms = ((Number(w ?? 0) * 7 + Number(d ?? 0)) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)) * 1000;
  return minus ? -ms : ms;
}

export function formatDuration(ms: number, allDay: boolean): string {
  if (allDay) return `P${Math.max(1, Math.round(ms / 86_400_000))}D`;
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `PT${h ? `${h}H` : ''}${m || !h ? `${m}M` : ''}`;
}

export interface EventSpan {
  start: Date;
  end: Date;
  allDay: boolean;
}

export function eventSpan(event: Pick<CalendarEvent, 'start' | 'timeZone' | 'duration' | 'showWithoutTime'>): EventSpan {
  const allDay = Boolean(event.showWithoutTime);
  const start = zonedToDate(event.start, allDay ? null : event.timeZone);
  if (allDay) {
    // Whole days, counted on the calendar: a day is not always 24 hours long.
    const days = Math.max(1, Math.round(parseDuration(event.duration) / 86_400_000));
    return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + days), allDay };
  }
  return { start, end: new Date(start.getTime() + parseDuration(event.duration)), allDay };
}

/** Calendar days from `a` to `b` (local dates), whatever the daylight-saving changes in between. */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000);
}

/** The days shown for `month` (0-11): full weeks, starting on Monday. */
export function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  // Drop a trailing week that belongs entirely to the next month.
  return days[35]!.getMonth() !== month ? days.slice(0, 35) : days;
}

/** The seven days (Monday first) of the week containing `date`. */
export function weekDays(date: Date): Date[] {
  const offset = (date.getDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, i) => new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset + i));
}

export type CalendarView = 'month' | 'week' | 'day';

/** The date `step` months, weeks or days away from `date`, for the view's arrows. */
export function shiftDate(date: Date, view: CalendarView, step: number): Date {
  if (view === 'month') return new Date(date.getFullYear(), date.getMonth() + step, 1);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + step * (view === 'week' ? 7 : 1));
}

export interface PlacedEvent<T> {
  item: T;
  /** Minutes from the start of the day, clipped to the day. */
  startMinute: number;
  endMinute: number;
  /** Side by side placement of overlapping events: column index and column count. */
  column: number;
  columns: number;
}

/**
 * Places the timed events of one local day on a time grid. Events that overlap
 * share the width in columns; each group of overlapping events gets as many
 * columns as it needs.
 */
export function layoutDay<T>(items: { item: T; span: EventSpan }[], day: Date, minHeightMinutes = 20): PlacedEvent<T>[] {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  const minutes = (dayEnd - dayStart) / 60_000;
  const placed = items
    .filter(({ span }) => !span.allDay && overlapsDay(span, day))
    .map(({ item, span }) => {
      const startMinute = Math.max(0, Math.round((span.start.getTime() - dayStart) / 60_000));
      const end = Math.min(minutes, Math.round((span.end.getTime() - dayStart) / 60_000));
      return { item, startMinute, endMinute: Math.max(end, Math.min(minutes, startMinute + minHeightMinutes)), column: 0, columns: 1 };
    })
    .sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute);

  let group: typeof placed = [];
  let groupEnd = -1;
  const columnEnds: number[] = [];
  const close = () => {
    for (const p of group) p.columns = columnEnds.length;
    group = [];
    columnEnds.length = 0;
  };
  for (const p of placed) {
    if (p.startMinute >= groupEnd) close();
    let column = columnEnds.findIndex((end) => end <= p.startMinute);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(p.endMinute);
    } else {
      columnEnds[column] = p.endMinute;
    }
    p.column = column;
    group.push(p);
    groupEnd = Math.max(groupEnd, p.endMinute);
  }
  close();
  return placed;
}

export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Whether the event overlaps the local day `day`. */
export function overlapsDay(span: EventSpan, day: Date): boolean {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  const end = Math.max(span.end.getTime(), span.start.getTime() + 1);
  return span.start.getTime() < dayEnd && end > dayStart;
}

/** UTC "YYYY-MM-DDTHH:MM:SS" (no Z), the form Cyrus accepts in CalendarEvent/query filters. */
const utcFilterDate = (d: Date) => d.toISOString().slice(0, 19);

export const calendarKeys = {
  calendars: ['calendars'] as const,
  events: (from: string, to: string) => ['events', from, to] as const,
  allEvents: ['events'] as const,
};

export function useCalendars() {
  return useQuery({
    queryKey: calendarKeys.calendars,
    queryFn: async () => (await jmap.call<{ list: Calendar[] }>('Calendar/get', {}, USING_CALENDARS)).list,
    staleTime: 5 * 60_000,
  });
}

export const EVENT_PROPERTIES = [
  'calendarIds', 'title', 'description', 'start', 'timeZone', 'duration', 'showWithoutTime', 'locations', 'recurrenceRules', 'recurrenceId', 'baseEventId', 'uid',
];

/** Events overlapping [from, to), with recurring events expanded into occurrences. */
export function useEvents(from: Date, to: Date) {
  return useQuery({
    queryKey: calendarKeys.events(from.toISOString(), to.toISOString()),
    queryFn: async () => {
      const accountId = await jmap.accountId();
      const results = await jmap.batch((b) => {
        const q = b.add('CalendarEvent/query', {
          accountId,
          filter: { after: utcFilterDate(from), before: utcFilterDate(to) },
          expandRecurrences: true,
        });
        b.add('CalendarEvent/get', { accountId, '#ids': b.ref(q, 'CalendarEvent/query', '/ids'), properties: EVENT_PROPERTIES });
      }, USING_CALENDARS);
      return (results.get('c1') as { list: CalendarEvent[] }).list;
    },
  });
}

export interface EventInput {
  calendarId: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  /** Local wall-clock values in the browser's zone. */
  start: string;
  end: string;
  repeat: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
}

/** The JSCalendar properties for an event edited in the browser's time zone. */
export function eventProperties(input: EventInput): Record<string, unknown> {
  const zone = userTimeZone();
  const start = zonedToDate(input.start, input.allDay ? null : zone);
  const end = zonedToDate(input.end, input.allDay ? null : zone);
  const duration = input.allDay
    ? `P${Math.max(1, daysBetween(start, end) + 1)}D` // the last day is included
    : formatDuration(end.getTime() - start.getTime(), false);
  return {
    '@type': 'Event',
    calendarIds: { [input.calendarId]: true },
    title: input.title.trim() || '(no title)',
    description: input.description,
    start: input.allDay ? `${input.start.slice(0, 10)}T00:00:00` : `${input.start.slice(0, 16)}:00`,
    timeZone: input.allDay ? null : zone,
    duration,
    showWithoutTime: input.allDay,
    locations: input.location.trim() ? { l1: { '@type': 'Location', name: input.location.trim() } } : null,
    recurrenceRules: input.repeat === 'none' ? null : [{ '@type': 'RecurrenceRule', frequency: input.repeat }],
  };
}

/**
 * What to send for an edit: only the fields that changed, so properties the
 * webmail does not show (other locations, links, alerts, the event's own time
 * zone…) are kept as they are.
 */
export function eventPatch(original: CalendarEvent, before: EventInput, after: EventInput, textOnly: boolean): Record<string, unknown> {
  const all = eventProperties(after);
  const patch: Record<string, unknown> = {};
  if (after.title !== before.title) patch.title = all.title;
  if (after.description !== before.description) patch.description = all.description;
  if (after.location !== before.location) {
    const keys = Object.keys(original.locations ?? {});
    const name = after.location.trim();
    if (keys.length === 0) patch.locations = all.locations;
    else if (name) patch[`locations/${keys[0]}/name`] = name;
    else if (keys.length === 1) patch.locations = null;
    else patch[`locations/${keys[0]}`] = null;
  }
  if (textOnly) return patch;
  const timesChanged = after.start !== before.start || after.end !== before.end || after.allDay !== before.allDay;
  if (timesChanged) {
    for (const key of ['start', 'timeZone', 'duration', 'showWithoutTime'] as const) patch[key] = all[key];
  }
  if (after.repeat !== before.repeat) patch.recurrenceRules = all.recurrenceRules;
  if (after.calendarId !== before.calendarId) patch.calendarIds = all.calendarIds;
  return patch;
}

export function useSaveEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input, edit }: { id: string | null; input: EventInput; edit?: { original: CalendarEvent; before: EventInput; textOnly: boolean } }) => {
      const properties = edit ? eventPatch(edit.original, edit.before, input, edit.textOnly) : eventProperties(input);
      if (id && Object.keys(properties).length === 0) return;
      const result = await jmap.call<{ notCreated?: Record<string, { type: string; description?: string }>; notUpdated?: Record<string, { type: string; description?: string }> }>(
        'CalendarEvent/set',
        id ? { update: { [id]: properties } } : { create: { e: properties } },
        USING_CALENDARS,
      );
      const failure = Object.values(result.notCreated ?? {})[0] ?? Object.values(result.notUpdated ?? {})[0];
      if (failure) throw new Error(`Could not save the event (${failure.description ?? failure.type})`);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: calendarKeys.allEvents }),
  });
}

export function useDeleteEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const result = await jmap.call<{ notDestroyed?: Record<string, { type: string }> }>('CalendarEvent/set', { destroy: [id] }, USING_CALENDARS);
      const failure = Object.values(result.notDestroyed ?? {})[0];
      if (failure) throw new Error(`Could not delete the event (${failure.type})`);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: calendarKeys.allEvents }),
  });
}
