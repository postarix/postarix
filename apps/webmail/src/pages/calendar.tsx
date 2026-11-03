import { Button } from '@postarix/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@postarix/ui/components/dialog';
import { cn } from '@postarix/ui/lib/utils';
import { CalendarPlus, ChevronLeft, ChevronRight, MapPin, Repeat, Share2, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { type EventDraft, EventDialog } from '@/components/event-dialog';
import { ImportButton } from '@/components/import-button';
import { errorMessage } from '@/lib/api';
import { ShareDialog } from '@/components/share-dialog';
import { TimeGrid } from '@/components/time-grid';
import { type AccountEvent, type CalendarView, calendarKeys, dayKey, eventSpan, monthGrid, overlapsDay, shiftDate, useCalendars, useEvents, weekDays } from '@/lib/calendar';
import { navigate } from '@/lib/router';
import { t } from '@/lib/i18n';

const time = (d: Date) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);

function parseDate(value: string | null): Date {
  if (value) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y!, m! - 1, d!);
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function weekTitle(first: Date, last: Date): string {
  const format = (d: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, options).format(d);
  if (first.getMonth() === last.getMonth()) return `${first.getDate()} – ${format(last, { day: 'numeric', month: 'long', year: 'numeric' })}`;
  return `${format(first, { day: 'numeric', month: 'short' })} – ${format(last, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function EventChip({ event, onOpen }: { event: AccountEvent; onOpen: () => void }) {
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
        span.allDay ? 'bg-accent font-medium text-accent-foreground ring-1 ring-ink/15 ring-inset hover:bg-ink/15' : 'hover:bg-muted',
      )}
    >
      {span.allDay ? null : <span className="size-1.5 shrink-0 rounded-full bg-ink" aria-hidden />}
      {span.allDay ? null : <span className="shrink-0 text-muted-foreground tabular-nums">{time(span.start)}</span>}
      <span className="truncate">{event.title}</span>
      {event.participants ? <Users className="ml-auto size-3 shrink-0 text-muted-foreground" aria-label={t('With guests')} /> : null}
    </button>
  );
}

const VIEWS: { view: CalendarView; label: string }[] = [
  { view: 'month', label: t('Month') },
  { view: 'week', label: t('Week') },
  { view: 'day', label: t('Day') },
];

export function CalendarPage({ date, view, email, name }: { date: string | null; view: CalendarView; email: string; name: string }) {
  const focus = parseDate(date);
  const month = focus.getMonth();
  const focusKey = dayKey(focus);
  const days = useMemo(() => {
    const [y, m, d] = focusKey.split('-').map(Number);
    const at = new Date(y!, m! - 1, d!);
    return view === 'month' ? monthGrid(at.getFullYear(), at.getMonth()) : view === 'week' ? weekDays(at) : [at];
  }, [view, focusKey]);
  const from = days[0]!;
  const to = new Date(days.at(-1)!.getFullYear(), days.at(-1)!.getMonth(), days.at(-1)!.getDate() + 1);
  const calendars = useCalendars();
  const accountIds = useMemo(() => [...new Set((calendars.data ?? []).map((c) => c.accountId))], [calendars.data]);
  const events = useEvents(from, to, accountIds);
  const [draft, setDraft] = useState<EventDraft | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const own = (calendars.data ?? []).filter((c) => c.sharedBy === null);
  const shared = (calendars.data ?? []).filter((c) => c.sharedBy !== null);
  const [dayList, setDayList] = useState<Date | null>(null);
  const todayKey = dayKey(new Date());

  const byDay = useMemo(() => {
    const map = new Map<string, AccountEvent[]>();
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

  const go = (d: Date, v: CalendarView = view) => navigate(`/calendar?date=${dayKey(d)}${v === 'month' ? '' : `&view=${v}`}`);
  const monthTitle = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(focus);
  const title =
    view === 'day'
      ? new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(focus)
      : view === 'week'
        ? weekTitle(days[0]!, days[6]!)
        : monthTitle;
  const unit = view === 'month' ? 'month' : view === 'week' ? 'week' : 'day';
  const weekdays = days.slice(0, 7).map((d) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d));
  const agendaDays = days.filter((d) => (view !== 'month' || d.getMonth() === month) && (byDay.get(dayKey(d))?.length ?? 0) > 0);
  const newAt = (day: Date) => setDraft({ start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0), allDay: false });
  const timedView = view !== 'month';

  const nav = (
    <div className="flex flex-col gap-4">
      <Button variant="stamp" className="h-9 w-full justify-start" onClick={() => newAt(focus)}>
        <CalendarPlus aria-hidden />{t('New event')}</Button>
      <div className="px-1">
        <p className="mb-1.5 px-1.5 text-xs font-medium text-sidebar-muted">{t('Calendars')}</p>
        <ul className="space-y-1">
          {own.map((c) => (
            <li key={`${c.accountId}-${c.id}`} className="group/cal flex items-center gap-2.5 px-1.5 py-1 text-sm">
              <span className="size-2.5 rounded-[3px] bg-ink ring-1 ring-white/20" aria-hidden />
              <span className="flex-1 truncate capitalize">{c.name}</span>
              <button
                type="button"
                aria-label={`Share ${c.name}`}
                onClick={() => setSharing(c.id)}
                className="grid size-6 place-items-center rounded text-sidebar-muted hover:bg-sidebar-accent hover:text-white focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
              >
                <Share2 className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        {shared.length ? (
          <>
            <p className="mt-4 mb-1.5 px-1.5 text-xs font-medium text-sidebar-muted">{t('Shared with you')}</p>
            <ul className="space-y-1" aria-label={t('Shared with you')}>
              {shared.map((c) => (
                <li key={`${c.accountId}-${c.id}`} className="flex items-center gap-2.5 px-1.5 py-1 text-sm">
                  <span className="size-2.5 rounded-[3px] ring-1 ring-sidebar-muted" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate capitalize">{c.name}</span>
                    <span className="block truncate text-xs text-sidebar-muted">{c.sharedBy}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
      <ImportButton kind="calendar" queryKey={calendarKeys.allEvents} />
    </div>
  );

  return (
    <AppShell email={email} name={name} nav={nav}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4 md:px-5">
          <h1 className="mr-auto truncate text-lg font-semibold capitalize">{title}</h1>
          <div className="hidden items-center rounded-md border p-0.5 shadow-xs sm:flex" role="group" aria-label={t('View')}>
            {VIEWS.map(({ view: v, label }) => (
              <Button key={v} variant={v === view ? 'secondary' : 'ghost'} size="sm" className="h-7 px-2.5" aria-pressed={v === view} onClick={() => go(focus, v)}>
                {label}
              </Button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => go(new Date())}>{t('Today')}</Button>
          <div className="flex items-center rounded-md border shadow-xs">
            <Button variant="ghost" size="icon-sm" className="rounded-r-none" aria-label={`Previous ${unit}`} onClick={() => go(shiftDate(focus, view, -1))}>
              <ChevronLeft aria-hidden />
            </Button>
            <Button variant="ghost" size="icon-sm" className="rounded-l-none border-l" aria-label={`Next ${unit}`} onClick={() => go(shiftDate(focus, view, 1))}>
              <ChevronRight aria-hidden />
            </Button>
          </div>
        </div>
        {events.error ? <p className="px-5 pt-2 text-sm text-destructive">{errorMessage(events.error)}</p> : null}

        {/* Week and day: a time grid (the day view on small screens too) */}
        {timedView ? (
          <div className={cn('min-h-0 flex-1 flex-col overflow-hidden', view === 'day' ? 'flex' : 'hidden md:flex')}>
            <TimeGrid
              days={days}
              events={events.data ?? []}
              onOpen={(event) => setDraft({ event: event as AccountEvent })}
              onNew={(start, allDay) => setDraft({ start: allDay ? new Date(start.getFullYear(), start.getMonth(), start.getDate(), 9, 0) : start, allDay })}
            />
          </div>
        ) : null}

        {/* Month grid (larger screens) */}
        <div className={cn('hidden min-h-0 flex-1 flex-col overflow-hidden', view === 'month' && 'md:flex')} role="grid" aria-label={monthTitle}>
          <div className="grid grid-cols-7 border-b" role="row">
            {weekdays.map((w) => (
              <div key={w} role="columnheader" className="px-3 py-2 text-right text-xs font-medium text-muted-foreground capitalize">
                {w}
              </div>
            ))}
          </div>
          <div className={cn('grid min-h-0 flex-1 grid-cols-7', days.length > 35 ? 'grid-rows-6' : 'grid-rows-5')}>
            {Array.from({ length: days.length / 7 }, (_, week) => (
              <div key={week} role="row" className="contents">
                {days.slice(week * 7, week * 7 + 7).map((day) => {
                  const key = dayKey(day);
                  const list = byDay.get(key) ?? [];
                  const inMonth = day.getMonth() === month;
                  const isToday = key === todayKey;
                  const label = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(day);
                  return (
                    <div
                      key={key}
                      role="gridcell"
                      tabIndex={0}
                      aria-label={`${label}${list.length ? `, ${list.length} ${list.length === 1 ? 'event' : 'events'}` : ''}. Press Enter to add an event.`}
                      onClick={() => newAt(day)}
                      onKeyDown={(e) => {
                        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          newAt(day);
                        }
                      }}
                      className={cn(
                        'group flex min-h-0 cursor-pointer flex-col gap-0.5 overflow-hidden border-r border-b p-1.5 transition-colors [&:nth-child(7n)]:border-r-0',
                        'focus-visible:relative focus-visible:z-[1] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                        inMonth ? 'hover:bg-muted/50' : 'bg-muted/40 text-muted-foreground',
                      )}
                    >
                      <span
                        className={cn(
                          'mb-0.5 ml-auto grid size-6 place-items-center rounded-full text-xs tabular-nums',
                          isToday ? 'bg-stamp font-semibold text-stamp-foreground' : 'font-medium',
                        )}
                      >
                        {day.getDate()}
                      </span>
                      {list.slice(0, 3).map((event) => (
                        <EventChip key={`${event.accountId}-${event.id}-${key}`} event={event} onOpen={() => setDraft({ event })} />
                      ))}
                      {list.length > 3 ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDayList(day);
                          }}
                          className="rounded-md px-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          {list.length - 3}{' '}{t('more')}</button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Agenda (small screens, month and week) */}
        <div className={cn('relative min-h-0 flex-1 overflow-y-auto p-4 md:hidden', view === 'day' && 'hidden')}>
          {agendaDays.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">{t('Nothing planned this')}{' '}{unit}.</p>
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
                        <li key={`${event.accountId}-${event.id}`}>
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
                            {event.baseEventId || event.recurrenceRules?.length ? <Repeat className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-label={t('Repeats')} /> : null}
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
      {draft ? <EventDialog draft={draft} calendars={calendars.data ?? []} me={email} onClose={() => setDraft(null)} /> : null}
      {sharing ? <ShareDialog kind="calendars" id={sharing} onClose={() => setSharing(null)} /> : null}
      <Dialog open={dayList !== null} onOpenChange={(open) => (open ? undefined : setDayList(null))}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{dayList ? new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(dayList) : ''}</DialogTitle>
            <DialogDescription className="sr-only">{t('Every event of the day')}</DialogDescription>
          </DialogHeader>
          <ul className="grid gap-1">
            {(dayList ? (byDay.get(dayKey(dayList)) ?? []) : []).map((event) => (
              <li key={`${event.accountId}-${event.id}`}>
                <EventChip
                  event={event}
                  onOpen={() => {
                    setDayList(null);
                    setDraft({ event });
                  }}
                />
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
