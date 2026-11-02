import { CAPABILITIES, type Calendar, type CalendarEvent } from '@postarix/jmap-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { jmap } from './jmap';

export const USING_CALENDARS = [CAPABILITIES.core, CAPABILITIES.calendars];

export const userTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** "YYYY-MM-DDTHH:MM:SS" of `date` as seen in `timeZone` (or the browser's zone). */
export function toLocalDateTime(date: Date, timeZone?: string | null): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone ?? undefined,
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
export function zonedToDate(local: string, timeZone?: string | null): Date {
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
  return { start, end: new Date(start.getTime() + parseDuration(event.duration)), allDay };
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

export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Whether the event overlaps the local day `day`. */
export function overlapsDay(span: EventSpan, day: Date): boolean {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const dayEnd = dayStart + 86_400_000;
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
    ? formatDuration(end.getTime() - start.getTime() + 86_400_000, true) // the end day is included
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

export function useSaveEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input, textOnly }: { id: string | null; input: EventInput; textOnly?: boolean }) => {
      const all = eventProperties(input);
      // For a repeating series edited from one occurrence, only the text changes.
      const properties = textOnly ? { title: all.title, description: all.description, locations: all.locations } : all;
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
