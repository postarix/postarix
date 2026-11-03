import type { CalendarEvent } from '@postarix/jmap-client';
import { cn } from '@postarix/ui/lib/utils';
import { useEffect, useMemo, useRef, useState } from 'react';
import { dayKey, eventSpan, layoutDay, overlapsDay } from '@/lib/calendar';
import { t } from '@/lib/i18n';

const HOUR_HEIGHT = 48; // px
const time = (d: Date) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
const hourLabel = (h: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(2000, 0, 1, h));

/**
 * The week and day views: one column per day, hours down the side, all-day
 * events in a strip on top. Clicking an empty slot starts a new event there.
 */
export function TimeGrid({
  days,
  events,
  onOpen,
  onNew,
}: {
  days: Date[];
  events: CalendarEvent[];
  onOpen: (event: CalendarEvent) => void;
  onNew: (start: Date, allDay: boolean) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  // Open at the working day (about 7:30), not at midnight.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = HOUR_HEIGHT * 7.5;
  }, []);

  const spans = useMemo(() => events.map((item) => ({ item, span: eventSpan(item) })), [events]);
  const todayKey = dayKey(now);
  const nowMinute = now.getHours() * 60 + now.getMinutes();
  const columns = { gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Day headings and the all-day strip */}
      <div className="grid border-b" style={columns}>
        <div />
        {days.map((day) => {
          const isToday = dayKey(day) === todayKey;
          return (
            <div key={dayKey(day)} className="border-l px-2 py-2 text-center">
              <div className="text-xs font-medium text-muted-foreground capitalize">{new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day)}</div>
              <div className={cn('mx-auto mt-0.5 grid size-7 place-items-center rounded-full text-sm tabular-nums', isToday ? 'bg-stamp font-semibold text-stamp-foreground' : 'font-medium')}>
                {day.getDate()}
              </div>
            </div>
          );
        })}
        <div className="flex items-start justify-end pt-1 pr-2 text-[11px] text-muted-foreground">{t('All day')}</div>
        {days.map((day) => {
          const allDay = spans.filter(({ span }) => span.allDay && overlapsDay(span, day));
          return (
            <div
              key={`all-${dayKey(day)}`}
              className="min-h-7 cursor-pointer space-y-0.5 border-l p-0.5 hover:bg-muted/50"
              onClick={() => onNew(day, true)}
              aria-label={`All-day events, ${new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(day)}`}
            >
              {allDay.map(({ item }) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(item);
                  }}
                  className="block w-full truncate rounded-md bg-accent px-1.5 py-0.5 text-left text-xs font-medium text-accent-foreground ring-1 ring-ink/15 ring-inset hover:bg-ink/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {item.title}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {/* Hours */}
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="relative grid" style={{ ...columns, height: HOUR_HEIGHT * 24 }}>
          <div className="relative">
            {Array.from({ length: 23 }, (_, i) => (
              <span key={i} className="absolute right-2 -translate-y-1/2 text-[11px] text-muted-foreground tabular-nums" style={{ top: (i + 1) * HOUR_HEIGHT }}>
                {hourLabel(i + 1)}
              </span>
            ))}
          </div>
          {days.map((day) => {
            const placed = layoutDay(spans, day);
            const isToday = dayKey(day) === todayKey;
            const label = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(day);
            return (
              <div key={`grid-${dayKey(day)}`} className="relative border-l" role="group" aria-label={label}>
                {Array.from({ length: 24 }, (_, hour) => (
                  <button
                    key={hour}
                    type="button"
                    tabIndex={-1}
                    aria-label={`New event, ${label}, ${hourLabel(hour)}`}
                    onClick={() => onNew(new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0), false)}
                    className="block w-full border-b border-border/60 hover:bg-muted/40"
                    style={{ height: HOUR_HEIGHT }}
                  />
                ))}
                {placed.map(({ item, startMinute, endMinute, column, columns: count }) => {
                  const span = eventSpan(item);
                  return (
                    <button
                      key={`${item.id}-${dayKey(day)}`}
                      type="button"
                      onClick={() => onOpen(item)}
                      className="absolute overflow-hidden rounded-md border-l-[3px] border-ink bg-accent px-1.5 py-0.5 text-left text-xs text-accent-foreground shadow-xs ring-1 ring-ink/10 ring-inset hover:bg-ink/15 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      style={{
                        top: (startMinute / 60) * HOUR_HEIGHT,
                        height: Math.max(((endMinute - startMinute) / 60) * HOUR_HEIGHT - 2, 16),
                        left: `calc(${(column / count) * 100}% + 2px)`,
                        width: `calc(${100 / count}% - 4px)`,
                      }}
                    >
                      <span className="block truncate font-medium">{item.title}</span>
                      {endMinute - startMinute >= 45 ? (
                        <span className="block truncate text-muted-foreground tabular-nums">
                          {time(span.start)} – {time(span.end)}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
                {isToday ? (
                  <div className="pointer-events-none absolute inset-x-0 z-[1] h-0.5 bg-destructive" style={{ top: (nowMinute / 60) * HOUR_HEIGHT }} aria-hidden>
                    <span className="absolute -top-1 -left-1 size-2.5 rounded-full bg-destructive" />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
