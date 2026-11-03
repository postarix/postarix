import { Button } from '@postarix/ui/components/button';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@postarix/ui/components/dialog';
import { Field, FieldGroup, FieldLabel } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Spinner } from '@postarix/ui/components/spinner';
import { Textarea } from '@postarix/ui/components/textarea';
import { Trash2 } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { errorMessage } from '@/lib/api';
import {
  type AccountCalendar,
  type AccountEvent,
  type EventInput,
  eventSpan,
  guestsOf,
  organizerOf,
  STATUS_LABELS,
  toLocalDateTime,
  useAvailability,
  useCancelEvent,
  useDeleteEvent,
  useSaveEvent,
  useResources,
  useSetGuests,
  zonedToDate,
} from '@/lib/calendar';
import { parseAddresses } from '@/lib/format';
import { RecipientInput } from './recipient-input';
import { t } from '@/lib/i18n';

/** What the dialog edits: an existing event (or occurrence), or a new one starting at `start`. */
export type EventDraft = { event: AccountEvent } | { start: Date; allDay: boolean };

const calendarKey = (c: Pick<AccountCalendar, 'accountId' | 'id'>) => `${c.accountId}::${c.id}`;
const clock = (d: Date) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);

function initialInput(draft: EventDraft, calendars: AccountCalendar[]): EventInput {
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

export function EventDialog({
  draft,
  calendars,
  me,
  onClose,
}: {
  draft: EventDraft;
  calendars: AccountCalendar[];
  /** The person's own address. */
  me: string;
  onClose: () => void;
}) {
  const existing = 'event' in draft ? draft.event : null;
  // Occurrences of a repeating event are edited through the series.
  const seriesId = existing?.baseEventId ?? null;
  const ownAccount = calendars.find((c) => c.sharedBy === null)?.accountId ?? null;
  const writable = calendars.filter((c) => c.sharedBy === null || c.myRights?.mayWriteAll);
  const eventCalendar = existing ? calendars.find((c) => c.accountId === existing.accountId && existing.calendarIds[c.id]) : undefined;
  const readOnly = Boolean(existing && eventCalendar && eventCalendar.sharedBy !== null && !eventCalendar.myRights?.mayWriteAll);
  const [before] = useState<EventInput>(() => initialInput(draft, writable.length ? writable : calendars));
  const [input, setInput] = useState<EventInput>(before);
  // The account of the calendar chosen; calendars may still be loading when the dialog opens.
  const [pickedAccount, setAccountId] = useState<string | null>(null);
  const accountId = pickedAccount ?? existing?.accountId ?? writable[0]?.accountId ?? ownAccount;
  const organizer = existing ? organizerOf(existing) : null;
  const currentGuests = useMemo(() => (existing ? guestsOf(existing) : []), [existing]);
  const canInvite = !readOnly && accountId === ownAccount && (!organizer || organizer === me);
  const [guestText, setGuestText] = useState(() => currentGuests.map((g) => g.email).join(', '));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useSaveEvent();
  const remove = useDeleteEvent();
  const cancel = useCancelEvent();
  const setGuests = useSetGuests();
  const resources = useResources(canInvite);
  const set = (patch: Partial<EventInput>) => setInput((current) => ({ ...current, ...patch }));

  const parsedGuests = useMemo(() => parseAddresses(guestText), [guestText]);
  const guestEmails = useMemo(
    () => [...new Set(parsedGuests.addresses.map((a) => a.email.toLowerCase()))].filter((e) => e !== me),
    [parsedGuests, me],
  );

  // When the guests are busy, for timed events on one day.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const startAt = input.allDay ? null : safeDate(input.start, zone);
  const endAt = input.allDay ? null : safeDate(input.end, zone);
  const windowFrom = startAt ? new Date(startAt.getFullYear(), startAt.getMonth(), startAt.getDate()) : new Date(0);
  const windowTo = startAt ? new Date(startAt.getFullYear(), startAt.getMonth(), startAt.getDate() + 1) : new Date(0);
  const availability = useAvailability(guestEmails.slice(0, 20), windowFrom, windowTo, canInvite && Boolean(startAt));
  const conflicts = useMemo(() => {
    if (!availability.data || !startAt || !endAt) return null;
    const busyNow = availability.data.data.filter((p) =>
      p.busy.some((b) => Date.parse(b.start) < endAt.getTime() && Date.parse(b.end) > startAt.getTime()),
    );
    return { busyNow, data: availability.data.data, unavailable: availability.data.unavailable };
  }, [availability.data, startAt, endAt]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (readOnly) return onClose();
    if (!input.allDay && input.end <= input.start) return setError('The event must end after it starts.');
    if (input.allDay && input.end.slice(0, 10) < input.start.slice(0, 10)) return setError('The last day cannot be before the first.');
    if (canInvite && parsedGuests.invalid.length) return setError(`Check these guests: ${parsedGuests.invalid.join(', ')}`);
    try {
      const id = await save.mutateAsync({
        id: existing ? (seriesId ?? existing.id) : null,
        ...(accountId ? { accountId } : {}),
        input,
        ...(existing ? { edit: { original: existing, before, textOnly: Boolean(seriesId) } } : {}),
      });
      const changed = JSON.stringify(input) !== JSON.stringify(before);
      const guestsChanged = guestEmails.join(',') !== currentGuests.map((g) => g.email).join(',');
      if (canInvite && (guestsChanged || (guestEmails.length > 0 && changed))) {
        await setGuests.mutateAsync({ id, guests: guestEmails });
      }
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function destroy() {
    // A second click confirms: deleting also removes the event from synced devices.
    if (!confirmDelete) return setConfirmDelete(true);
    try {
      const id = seriesId ?? existing!.id;
      if (canInvite && currentGuests.length) await cancel.mutateAsync(id);
      else await remove.mutateAsync({ id, accountId: existing!.accountId });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const busy = save.isPending || setGuests.isPending;
  const dialogTitle = readOnly ? (existing?.title ?? 'Event') : existing ? 'Edit event' : 'New event';

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-xl">{dialogTitle}</DialogTitle>
          <DialogDescription className={seriesId || readOnly || (organizer && organizer !== me) ? undefined : 'sr-only'}>
            {readOnly
              ? `In ${eventCalendar?.sharedBy ?? 'a shared'} calendar, which you can only read.`
              : organizer && organizer !== me
                ? `Organized by ${organizer}. Changes here only affect your calendar.`
                : seriesId
                  ? 'This event repeats. Title, place and notes change for every occurrence; times stay as they are.'
                  : 'Event details'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <fieldset disabled={readOnly} className="contents">
          <FieldGroup className="gap-4">
            <Input
              aria-label={t('Title')}
              placeholder={t('Add a title')}
              value={input.title}
              onChange={(e) => set({ title: e.target.value })}
              autoFocus
              className="h-11 text-lg font-medium"
            />
            <Field orientation="horizontal">
              <Checkbox id="event-all-day" checked={input.allDay} disabled={Boolean(seriesId)} onCheckedChange={(v) => set({ allDay: v === true })} />
              <FieldLabel htmlFor="event-all-day" className="font-normal">{t('All day')}</FieldLabel>
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
                <FieldLabel htmlFor="event-repeat">{t('Repeats')}</FieldLabel>
                <NativeSelect id="event-repeat" value={input.repeat} disabled={Boolean(seriesId)} onChange={(e) => set({ repeat: e.target.value as EventInput['repeat'] })}>
                  <NativeSelectOption value="none">{t('Does not repeat')}</NativeSelectOption>
                  <NativeSelectOption value="daily">{t('Every day')}</NativeSelectOption>
                  <NativeSelectOption value="weekly">{t('Every week')}</NativeSelectOption>
                  <NativeSelectOption value="monthly">{t('Every month')}</NativeSelectOption>
                  <NativeSelectOption value="yearly">{t('Every year')}</NativeSelectOption>
                </NativeSelect>
              </Field>
              {writable.length > 1 && !readOnly ? (
                <Field>
                  <FieldLabel htmlFor="event-calendar">{t('Calendar')}</FieldLabel>
                  <NativeSelect
                    id="event-calendar"
                    value={`${accountId}::${input.calendarId}`}
                    // Events stay in their account: moving them to someone else's calendar is not possible.
                    disabled={Boolean(existing)}
                    onChange={(e) => {
                      const picked = writable.find((c) => calendarKey(c) === e.target.value);
                      if (!picked) return;
                      set({ calendarId: picked.id });
                      setAccountId(picked.accountId);
                    }}
                  >
                    {writable.map((c) => (
                      <NativeSelectOption key={calendarKey(c)} value={calendarKey(c)}>
                        {c.sharedBy ? `${c.name} (${c.sharedBy})` : c.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              ) : null}
            </div>
            <Field>
              <FieldLabel htmlFor="event-location">{t('Place')}</FieldLabel>
              <Input id="event-location" value={input.location} onChange={(e) => set({ location: e.target.value })} placeholder={t('Room, address or link')} />
            </Field>
            <Field>
              <FieldLabel htmlFor="event-description">{t('Notes')}</FieldLabel>
              <Textarea id="event-description" rows={3} value={input.description} onChange={(e) => set({ description: e.target.value })} />
            </Field>
            {canInvite ? (
              <Field>
                <FieldLabel htmlFor="event-guests">{t('Guests')}</FieldLabel>
                <RecipientInput id="event-guests" value={guestText} onChange={setGuestText} placeholder={t('Add people by email')} />
                {resources.data?.some((r) => !guestEmails.includes(r.email)) ? (
                  <div className="flex flex-wrap items-center gap-1.5" aria-label={t('Rooms and equipment')}>
                    <span className="text-xs text-muted-foreground">{t('Book:')}</span>
                    {resources.data
                      .filter((r) => !guestEmails.includes(r.email))
                      .map((r) => (
                        <Button
                          key={r.email}
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setGuestText((text) => (text.trim() ? `${text.trim().replace(/,$/, '')}, ${r.email}` : r.email))}
                        >
                          {r.name}
                        </Button>
                      ))}
                  </div>
                ) : null}
                <GuestList guests={currentGuests} />
                {conflicts && guestEmails.length ? (
                  <p className="text-xs text-muted-foreground" role="status">
                    {conflicts.busyNow.length
                      ? `Busy at this time: ${conflicts.busyNow.map((p) => p.email).join(', ')}.`
                      : conflicts.data.length
                        ? 'Your colleagues are free at this time.'
                        : null}
                    {conflicts.data.some((p) => p.busy.length) ? (
                      <span className="block">
                        {conflicts.data
                          .filter((p) => p.busy.length)
                          .map((p) => `${p.email}: ${p.busy.map((b) => `${clock(new Date(b.start))}–${clock(new Date(b.end))}`).join(', ')}`)
                          .join(' · ')}
                      </span>
                    ) : null}
                  </p>
                ) : null}
              </Field>
            ) : currentGuests.length ? (
              <Field>
                <FieldLabel>{t('Guests')}</FieldLabel>
                <GuestList guests={currentGuests} />
              </Field>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </FieldGroup>
          </fieldset>
          <DialogFooter className="mt-4 items-center sm:justify-between">
            {existing && !readOnly ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={remove.isPending || cancel.isPending}
                onClick={() => void destroy()}
              >
                <Trash2 aria-hidden />
                {confirmDelete
                  ? canInvite && currentGuests.length
                    ? 'Delete and tell the guests'
                    : seriesId
                      ? 'Delete every occurrence'
                      : 'Delete for good'
                  : seriesId
                    ? 'Delete the series'
                    : 'Delete'}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              {readOnly ? (
                <Button type="button" onClick={onClose}>{t('Close')}</Button>
              ) : (
                <>
                  <Button type="button" variant="outline" onClick={onClose}>{t('Cancel')}</Button>
                  <Button type="submit" disabled={busy}>
                    {busy ? <Spinner /> : null}
                    {canInvite && guestEmails.length ? 'Save and send' : 'Save'}
                  </Button>
                </>
              )}
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function safeDate(local: string, zone: string): Date | null {
  try {
    return zonedToDate(local, zone);
  } catch {
    return null;
  }
}

function GuestList({ guests }: { guests: { email: string; name: string | null; status: string }[] }) {
  if (!guests.length) return null;
  return (
    <ul className="grid gap-1 text-sm" aria-label={t('Answers')}>
      {guests.map((g) => (
        <li key={g.email} className="flex items-center justify-between gap-3">
          <span className="truncate">{g.name ? `${g.name} <${g.email}>` : g.email}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{STATUS_LABELS[g.status] ?? g.status}</span>
        </li>
      ))}
    </ul>
  );
}
