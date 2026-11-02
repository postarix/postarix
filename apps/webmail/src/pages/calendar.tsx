import type { CalendarEvent } from '@postarix/jmap-client';
import { Button } from '@postarix/ui/components/button';
import { cn } from '@postarix/ui/lib/utils';
import { CalendarPlus, ChevronLeft, ChevronRight, MapPin, Repeat } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { type EventDraft, EventDialog } from '@/components/event-dialog';
import { errorMessage } from '@/lib/api';
import { dayKey, eventSpan, monthGrid, overlapsDay, useCalendars, useEvents } from '@/lib/calendar';
import { navigate } from '@/lib/router';

const time = (d: Date) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);

function parseDate(value: string | null): Date {
  if (value) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y!, m! - 1, d!);
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function EventChip({ event, onOpen }: { event: CalendarEvent; onOpen: () => void }) {
  const span = eventSpan(event);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className={cn(
        'flex w-full items-center gap-1.5 truncate rounded-md px-1.5 py-0.5 text-left text-xs transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        span.allDay ? 'bg-primary font-medium text-primary-foreground hover:opacity-90' : 'hover:bg-accent',
      )}
    >
      {span.allDay ? null : <span className="size-1.5 shrink-0 rounded-full bg-airmail-blue" aria-hidden />}
      {span.allDay ? null : <span className="shrink-0 text-muted-foreground tabular-nums">{time(span.start)}</span>}
      <span className="truncate">{event.title}</span>
    </button>
  );
}

export function CalendarPage({ date, email, name }: { date: string | null; email: string; name: string }) {
  const focus = parseDate(date);
  const year = focus.getFullYear();
  const month = focus.getMonth();
  const days = useMemo(() => monthGrid(year, month), [year, month]);
  const from = days[0]!;
  const to = new Date(days.at(-1)!.getFullYear(), days.at(-1)!.getMonth(), days.at(-1)!.getDate() + 1);
  const calendars = useCalendars();
  const events = useEvents(from, to);
  const [draft, setDraft] = useState<EventDraft | null>(null);
  const todayKey = dayKey(new Date());

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events.data ?? []) {
      const span = eventSpan(event);
      for (const day of days) {
        if (!overlapsDay(span, day)) continue;
        const list = map.get(dayKey(day)) ?? [];
        list.push(event);
        map.set(dayKey(day), list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => Number(eventSpan(b).allDay) - Number(eventSpan(a).allDay) || eventSpan(a).start.getTime() - eventSpan(b).start.getTime());
    }
    return map;
  }, [events.data, days]);

  const go = (d: Date) => navigate(`/calendar?date=${dayKey(d)}`);
  const monthTitle = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(focus);
  const weekdays = days.slice(0, 7).map((d) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d));
  const agendaDays = days.filter((d) => d.getMonth() === month && (byDay.get(dayKey(d))?.length ?? 0) > 0);
  const newAt = (day: Date) => setDraft({ start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0), allDay: false });

  const nav = (
    <div className="flex flex-col gap-4">
      <Button variant="stamp" size="lg" className="w-full justify-start" onClick={() => newAt(focus)}>
        <CalendarPlus aria-hidden />
        New event
      </Button>
      <div className="px-1">
        <p className="mb-2 text-xs font-medium text-sidebar-muted">Calendars</p>
        <ul className="space-y-1">
          {(calendars.data ?? []).map((c) => (
            <li key={c.id} className="flex items-center gap-2.5 px-1.5 py-1 text-sm">
              <span className="size-2.5 rounded-full bg-stamp" aria-hidden />
              <span className="truncate capitalize">{c.name}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );

  return (
    <AppShell email={email} name={name} nav={nav}>
      <div className="flex h-full min-h-0 flex-col px-3 pt-4 pb-3 md:px-6">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h1 className="mr-auto text-3xl font-semibold capitalize">{monthTitle}</h1>
          <Button variant="outline" size="sm" onClick={() => go(new Date())}>
            Today
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => go(new Date(year, month - 1, 1))}>
            <ChevronLeft aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => go(new Date(year, month + 1, 1))}>
            <ChevronRight aria-hidden />
          </Button>
        </div>
        {events.error ? <p className="mb-2 text-sm text-destructive">{errorMessage(events.error)}</p> : null}

        {/* Month grid (larger screens) */}
        <div className="hidden min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card md:flex" role="grid" aria-label={monthTitle}>
          <div className="grid grid-cols-7 border-b" role="row">
            {weekdays.map((w) => (
              <div key={w} role="columnheader" className="px-3 py-2 text-xs font-medium text-muted-foreground capitalize">
                {w}
              </div>
            ))}
          </div>
          <div className={cn('grid min-h-0 flex-1 grid-cols-7', days.length > 35 ? 'grid-rows-6' : 'grid-rows-5')}>
            {days.map((day) => {
              const key = dayKey(day);
              const list = byDay.get(key) ?? [];
              const inMonth = day.getMonth() === month;
              const isToday = key === todayKey;
              return (
                <div
                  key={key}
                  role="gridcell"
                  aria-label={new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(day)}
                  onClick={() => newAt(day)}
                  className={cn(
                    'group flex min-h-0 cursor-pointer flex-col gap-0.5 overflow-hidden border-r border-b p-1.5 transition-colors [&:nth-child(7n)]:border-r-0',
                    inMonth ? 'hover:bg-accent/40' : 'bg-muted/40 text-muted-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'mb-0.5 grid size-7 place-items-center rounded-full text-sm tabular-nums',
                      isToday ? 'bg-stamp font-semibold text-stamp-foreground' : 'font-medium',
                    )}
                  >
                    {day.getDate()}
                  </span>
                  {list.slice(0, 3).map((event) => (
                    <EventChip key={`${event.id}-${key}`} event={event} onOpen={() => setDraft({ event })} />
                  ))}
                  {list.length > 3 ? <span className="px-1.5 text-xs text-muted-foreground">{list.length - 3} more</span> : null}
                </div>
              );
            })}
          </div>
        </div>

        {/* Agenda (small screens) */}
        <div className="min-h-0 flex-1 overflow-y-auto md:hidden">
          {agendaDays.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">Nothing planned this month.</p>
          ) : (
            <ol className="space-y-4">
              {agendaDays.map((day) => (
                <li key={dayKey(day)}>
                  <h2 className={cn('mb-1.5 text-sm font-semibold', dayKey(day) === todayKey && 'text-primary')}>
                    {new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(day)}
                  </h2>
                  <ul className="space-y-1.5">
                    {(byDay.get(dayKey(day)) ?? []).map((event) => {
                      const span = eventSpan(event);
                      return (
                        <li key={event.id}>
                          <button type="button" onClick={() => setDraft({ event })} className="flex w-full gap-3 rounded-lg border bg-card p-3 text-left">
                            <span className="w-14 shrink-0 text-xs text-muted-foreground tabular-nums">{span.allDay ? 'All day' : time(span.start)}</span>
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium">{event.title}</span>
                              {Object.values(event.locations ?? {})[0]?.name ? (
                                <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                                  <MapPin className="size-3" aria-hidden />
                                  {Object.values(event.locations ?? {})[0]?.name}
                                </span>
                              ) : null}
                            </span>
                            {event.baseEventId || event.recurrenceRules?.length ? <Repeat className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-label="Repeats" /> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
      {draft ? <EventDialog draft={draft} calendars={calendars.data ?? []} onClose={() => setDraft(null)} /> : null}
    </AppShell>
  );
}
