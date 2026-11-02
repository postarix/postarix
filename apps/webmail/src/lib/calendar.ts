import { CAPABILITIES, type Calendar, type CalendarEvent, type Participant } from '@postarix/jmap-client';
import { api } from './api';
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
  sharing: ['calendar-sharing'] as const,
  availability: (emails: string[], from: string, to: string) => ['availability', emails.join(','), from, to] as const,
};

/** A calendar of the person's own account, or one a colleague shares with them. */
export interface AccountCalendar extends Calendar {
  accountId: string;
  /** The owner's account name (their address) for shared calendars, null for the person's own. */
  sharedBy: string | null;
}

/** An event, with the account it belongs to. */
export type AccountEvent = CalendarEvent & { accountId: string };

/** The person's own account first, then accounts that share calendars with them. */
async function calendarAccounts(): Promise<{ id: string; name: string; personal: boolean }[]> {
  const session = await jmap.session(true);
  return Object.entries(session.accounts)
    .filter(([, a]) => CAPABILITIES.calendars in a.accountCapabilities)
    .map(([id, a]) => ({ id, name: a.name, personal: a.isPersonal }))
    .sort((a, b) => Number(b.personal) - Number(a.personal) || a.name.localeCompare(b.name));
}

export function useCalendars() {
  return useQuery({
    queryKey: calendarKeys.calendars,
    queryFn: async (): Promise<AccountCalendar[]> => {
      const accounts = await calendarAccounts();
      const results = await jmap.batch((b) => {
        for (const account of accounts) b.add('Calendar/get', { accountId: account.id });
      }, USING_CALENDARS);
      return accounts.flatMap((account, i) =>
        ((results.get(`c${i}`) as { list: Calendar[] } | undefined)?.list ?? []).map((c) => ({
          ...c,
          accountId: account.id,
          sharedBy: account.personal ? null : account.name,
        })),
      );
    },
    staleTime: 5 * 60_000,
  });
}

export const EVENT_PROPERTIES = [
  'calendarIds', 'title', 'description', 'start', 'timeZone', 'duration', 'showWithoutTime', 'locations', 'recurrenceRules', 'recurrenceId', 'baseEventId', 'uid',
  'participants', 'replyTo',
];

/** Events overlapping [from, to) in every calendar the person sees, with recurring events expanded into occurrences. */
export function useEvents(from: Date, to: Date, accountIds: string[]) {
  return useQuery({
    queryKey: [...calendarKeys.events(from.toISOString(), to.toISOString()), accountIds.join(',')],
    enabled: accountIds.length > 0,
    queryFn: async (): Promise<AccountEvent[]> => {
      const results = await jmap.batch((b) => {
        for (const accountId of accountIds) {
          const q = b.add('CalendarEvent/query', {
            accountId,
            filter: { after: utcFilterDate(from), before: utcFilterDate(to) },
            expandRecurrences: true,
          });
          b.add('CalendarEvent/get', { accountId, '#ids': b.ref(q, 'CalendarEvent/query', '/ids'), properties: EVENT_PROPERTIES });
        }
      }, USING_CALENDARS);
      return accountIds.flatMap((accountId, i) =>
        ((results.get(`c${i * 2 + 1}`) as { list: CalendarEvent[] } | undefined)?.list ?? []).map((e) => ({ ...e, accountId })),
      );
    },
  });
}

/** The address a calendar user address ("mailto:…") points to. */
const mailto = (value: string | null | undefined) => {
  const match = value ? /^mailto:(.+)$/i.exec(value.trim()) : null;
  return match ? match[1]!.trim().toLowerCase() : null;
};

export const participantEmail = (p: Participant) => (p.email ?? mailto(p.sendTo?.imip) ?? '').toLowerCase();

/** The organizer of an event with guests, or null for a plain event. */
export function organizerOf(event: Pick<CalendarEvent, 'replyTo' | 'participants'>): string | null {
  const replyTo = mailto(event.replyTo?.imip);
  if (replyTo) return replyTo;
  const owner = Object.values(event.participants ?? {}).find((p) => p.roles?.owner);
  return owner ? participantEmail(owner) || null : null;
}

export interface Guest {
  email: string;
  name: string | null;
  status: string;
}

/** Everyone on the event except its organizer. */
export function guestsOf(event: Pick<CalendarEvent, 'replyTo' | 'participants'>): Guest[] {
  const organizer = organizerOf(event);
  return Object.values(event.participants ?? {})
    .map((p) => ({ email: participantEmail(p), name: p.name ?? null, status: p.participationStatus ?? 'needs-action' }))
    .filter((g) => g.email && g.email !== organizer);
}

export const STATUS_LABELS: Record<string, string> = {
  accepted: 'Going',
  tentative: 'Maybe',
  declined: 'Not going',
  'needs-action': 'Not answered',
  delegated: 'Delegated',
};

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
    mutationFn: async ({
      id,
      accountId,
      input,
      edit,
    }: {
      id: string | null;
      accountId?: string;
      input: EventInput;
      edit?: { original: CalendarEvent; before: EventInput; textOnly: boolean };
    }): Promise<string> => {
      const properties = edit ? eventPatch(edit.original, edit.before, input, edit.textOnly) : eventProperties(input);
      if (id && Object.keys(properties).length === 0) return id;
      const result = await jmap.call<{
        created?: Record<string, { id: string }>;
        notCreated?: Record<string, { type: string; description?: string }>;
        notUpdated?: Record<string, { type: string; description?: string }>;
      }>('CalendarEvent/set', { ...(accountId ? { accountId } : {}), ...(id ? { update: { [id]: properties } } : { create: { e: properties } }) }, USING_CALENDARS);
      const failure = Object.values(result.notCreated ?? {})[0] ?? Object.values(result.notUpdated ?? {})[0];
      if (failure) throw new Error(`Could not save the event (${failure.description ?? failure.type})`);
      return id ?? result.created!.e!.id;
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: calendarKeys.allEvents }),
  });
}

export function useDeleteEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, accountId }: { id: string; accountId?: string }) => {
      const result = await jmap.call<{ notDestroyed?: Record<string, { type: string }> }>(
        'CalendarEvent/set',
        { ...(accountId ? { accountId } : {}), destroy: [id] },
        USING_CALENDARS,
      );
      const failure = Object.values(result.notDestroyed ?? {})[0];
      if (failure) throw new Error(`Could not delete the event (${failure.type})`);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: calendarKeys.allEvents }),
  });
}

/** Sets who is invited to one of the person's own events; the server emails them. */
export function useSetGuests() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, guests }: { id: string; guests: string[] }) =>
      api<{ guests: Guest[]; notified: number }>(`/calendar/events/${encodeURIComponent(id)}/guests`, { method: 'PUT', body: { guests } }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: calendarKeys.allEvents }),
  });
}

/** Deletes one of the person's events with guests, telling them it is cancelled. */
export function useCancelEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ notified: number }>(`/calendar/events/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: calendarKeys.allEvents }),
  });
}

export interface Availability {
  data: { email: string; busy: { start: string; end: string }[] }[];
  /** People whose availability cannot be shown (outside the organization, or unknown). */
  unavailable: string[];
}

/** When colleagues are busy between `from` and `to`. */
export function useAvailability(emails: string[], from: Date, to: Date, enabled: boolean) {
  const sorted = [...emails].sort();
  return useQuery({
    queryKey: calendarKeys.availability(sorted, from.toISOString(), to.toISOString()),
    enabled: enabled && sorted.length > 0,
    queryFn: () =>
      api<Availability>(
        `/calendar/availability?${new URLSearchParams({ emails: sorted.join(','), from: from.toISOString(), to: to.toISOString() })}`,
      ),
    staleTime: 60_000,
  });
}

export type ShareAccess = 'read' | 'write';
export interface SharedCollection {
  id: string;
  name: string;
  shares: { email: string; access: ShareAccess }[];
}

export function useSharing() {
  return useQuery({
    queryKey: calendarKeys.sharing,
    queryFn: () => api<{ calendars: SharedCollection[]; addressBooks: SharedCollection[] }>('/calendar/sharing'),
  });
}

export function useSetSharing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, id, shares }: { kind: 'calendars' | 'address-books'; id: string; shares: SharedCollection['shares'] }) =>
      api<SharedCollection>(`/calendar/sharing/${kind}/${encodeURIComponent(id)}`, { method: 'PUT', body: { shares } }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: calendarKeys.sharing }),
  });
}
