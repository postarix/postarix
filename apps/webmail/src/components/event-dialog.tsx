import type { Calendar, CalendarEvent } from '@postarix/jmap-client';
import { Button } from '@postarix/ui/components/button';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@postarix/ui/components/dialog';
import { Field, FieldGroup, FieldLabel } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Spinner } from '@postarix/ui/components/spinner';
import { Textarea } from '@postarix/ui/components/textarea';
import { Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { type EventInput, eventSpan, toLocalDateTime, useDeleteEvent, useSaveEvent } from '@/lib/calendar';

/** What the dialog edits: an existing event (or occurrence), or a new one starting at `start`. */
export type EventDraft = { event: CalendarEvent } | { start: Date; allDay: boolean };

function initialInput(draft: EventDraft, calendars: Calendar[]): EventInput {
  const calendarId = calendars[0]?.id ?? 'Default';
  if ('event' in draft) {
    const { event } = draft;
    const span = eventSpan(event);
    // All-day events end at midnight after their last day; the dialog shows the last day.
    const endShown = span.allDay ? new Date(span.end.getFullYear(), span.end.getMonth(), span.end.getDate() - 1) : span.end;
    return {
      calendarId: Object.keys(event.calendarIds)[0] ?? calendarId,
      title: event.title,
      description: event.description ?? '',
      location: Object.values(event.locations ?? {})[0]?.name ?? '',
      allDay: span.allDay,
      start: toLocalDateTime(span.start).slice(0, 16),
      end: toLocalDateTime(endShown < span.start ? span.start : endShown).slice(0, 16),
      repeat: (event.recurrenceRules?.[0]?.frequency as EventInput['repeat']) ?? 'none',
    };
  }
  const start = new Date(draft.start);
  const end = new Date(start.getTime() + 60 * 60_000);
  return {
    calendarId,
    title: '',
    description: '',
    location: '',
    allDay: draft.allDay,
    start: toLocalDateTime(start).slice(0, 16),
    end: toLocalDateTime(draft.allDay ? start : end).slice(0, 16),
    repeat: 'none',
  };
}

export function EventDialog({ draft, calendars, onClose }: { draft: EventDraft; calendars: Calendar[]; onClose: () => void }) {
  const existing = 'event' in draft ? draft.event : null;
  // Occurrences of a repeating event are edited through the series.
  const seriesId = existing?.baseEventId ?? null;
  const [before] = useState<EventInput>(() => initialInput(draft, calendars));
  const [input, setInput] = useState<EventInput>(before);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useSaveEvent();
  const remove = useDeleteEvent();
  const set = (patch: Partial<EventInput>) => setInput((current) => ({ ...current, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!input.allDay && input.end <= input.start) return setError('The event must end after it starts.');
    if (input.allDay && input.end.slice(0, 10) < input.start.slice(0, 10)) return setError('The last day cannot be before the first.');
    try {
      await save.mutateAsync({
        id: existing ? (seriesId ?? existing.id) : null,
        input,
        ...(existing ? { edit: { original: existing, before, textOnly: Boolean(seriesId) } } : {}),
      });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-xl">{existing ? 'Edit event' : 'New event'}</DialogTitle>
          <DialogDescription className={seriesId ? undefined : 'sr-only'}>
            {seriesId ? 'This event repeats. Title, place and notes change for every occurrence; times stay as they are.' : 'Event details'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup className="gap-4">
            <Input
              aria-label="Title"
              placeholder="Add a title"
              value={input.title}
              onChange={(e) => set({ title: e.target.value })}
              autoFocus
              className="h-11 text-lg font-medium"
            />
            <Field orientation="horizontal">
              <Checkbox id="event-all-day" checked={input.allDay} disabled={Boolean(seriesId)} onCheckedChange={(v) => set({ allDay: v === true })} />
              <FieldLabel htmlFor="event-all-day" className="font-normal">
                All day
              </FieldLabel>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="event-start">{input.allDay ? 'First day' : 'Starts'}</FieldLabel>
                <Input
                  id="event-start"
                  type={input.allDay ? 'date' : 'datetime-local'}
                  value={input.allDay ? input.start.slice(0, 10) : input.start}
                  disabled={Boolean(seriesId)}
                  onChange={(e) => {
                    const value = input.allDay ? `${e.target.value}T00:00` : e.target.value;
                    set({ start: value, ...(value > input.end ? { end: value } : {}) });
                  }}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="event-end">{input.allDay ? 'Last day' : 'Ends'}</FieldLabel>
                <Input
                  id="event-end"
                  type={input.allDay ? 'date' : 'datetime-local'}
                  value={input.allDay ? input.end.slice(0, 10) : input.end}
                  disabled={Boolean(seriesId)}
                  onChange={(e) => set({ end: input.allDay ? `${e.target.value}T00:00` : e.target.value })}
                  required
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="event-repeat">Repeats</FieldLabel>
                <NativeSelect id="event-repeat" value={input.repeat} disabled={Boolean(seriesId)} onChange={(e) => set({ repeat: e.target.value as EventInput['repeat'] })}>
                  <NativeSelectOption value="none">Does not repeat</NativeSelectOption>
                  <NativeSelectOption value="daily">Every day</NativeSelectOption>
                  <NativeSelectOption value="weekly">Every week</NativeSelectOption>
                  <NativeSelectOption value="monthly">Every month</NativeSelectOption>
                  <NativeSelectOption value="yearly">Every year</NativeSelectOption>
                </NativeSelect>
              </Field>
              {calendars.length > 1 ? (
                <Field>
                  <FieldLabel htmlFor="event-calendar">Calendar</FieldLabel>
                  <NativeSelect id="event-calendar" value={input.calendarId} onChange={(e) => set({ calendarId: e.target.value })}>
                    {calendars.map((c) => (
                      <NativeSelectOption key={c.id} value={c.id}>
                        {c.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              ) : null}
            </div>
            <Field>
              <FieldLabel htmlFor="event-location">Place</FieldLabel>
              <Input id="event-location" value={input.location} onChange={(e) => set({ location: e.target.value })} placeholder="Room, address or link" />
            </Field>
            <Field>
              <FieldLabel htmlFor="event-description">Notes</FieldLabel>
              <Textarea id="event-description" rows={3} value={input.description} onChange={(e) => set({ description: e.target.value })} />
            </Field>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter className="items-center sm:justify-between">
              {existing ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={remove.isPending}
                  onClick={async () => {
                    // A second click confirms: deleting also removes the event from synced devices.
                    if (!confirmDelete) return setConfirmDelete(true);
                    try {
                      await remove.mutateAsync(seriesId ?? existing.id);
                      onClose();
                    } catch (e) {
                      setError(errorMessage(e));
                    }
                  }}
                >
                  <Trash2 aria-hidden />
                  {confirmDelete ? (seriesId ? 'Delete every occurrence' : 'Delete for good') : seriesId ? 'Delete the series' : 'Delete'}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={save.isPending}>
                  {save.isPending ? <Spinner /> : null}
                  Save
                </Button>
              </div>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
