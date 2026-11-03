import { Button } from '@postarix/ui/components/button';
import { Spinner } from '@postarix/ui/components/spinner';
import { CalendarDays, MapPin, Repeat } from 'lucide-react';
import { errorMessage } from '@/lib/api';
import { STATUS_LABELS } from '@/lib/calendar';
import { type Invitation, useAnswerInvitation, useApplyInvitation, useInvitation } from '@/lib/invitations';
import { t } from '@/lib/i18n';

function when(invitation: Invitation): string {
  if (!invitation.start) return '';
  const start = new Date(invitation.start);
  if (invitation.allDay) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeZone: 'UTC' }).format(start);
  }
  const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(start);
  const time = (d: Date) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
  return invitation.end ? `${day}, ${time(start)} – ${time(new Date(invitation.end))}` : `${day}, ${time(start)}`;
}

const HEADINGS: Record<Invitation['method'], string> = {
  REQUEST: 'Invitation',
  REPLY: 'Answer to your invitation',
  CANCEL: 'Event cancelled',
};

const ANSWERS = [
  { response: 'accepted', label: t('Going') },
  { response: 'tentative', label: t('Maybe') },
  { response: 'declined', label: t('Not going') },
] as const;

/** What a calendar message is about, with the answer or calendar update it allows. */
export function InvitationCard({ emailId }: { emailId: string }) {
  const invitation = useInvitation(emailId, true);
  const answer = useAnswerInvitation(emailId);
  const apply = useApplyInvitation(emailId);
  const data = invitation.data;
  if (!data) return null;
  const error = answer.error ?? apply.error;
  const replier = data.method === 'REPLY' ? data.attendees[0] : undefined;

  return (
    <section aria-label={HEADINGS[data.method]} className="rounded-xl border bg-card p-4 shadow-xs">
      <div className="flex items-start gap-3">
        <CalendarDays className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{HEADINGS[data.method]}</p>
          <h2 className="font-semibold break-words">{data.title || '(no title)'}</h2>
          <p className="text-sm">{when(data)}</p>
          {data.location ? (
            <p className="flex items-center gap-1 text-sm text-muted-foreground">
              <MapPin className="size-3.5" aria-hidden />
              {data.location}
            </p>
          ) : null}
          {data.repeats ? (
            <p className="flex items-center gap-1 text-sm text-muted-foreground">
              <Repeat className="size-3.5" aria-hidden />
              {t('Repeats')}
            </p>
          ) : null}
          {data.organizer && data.method === 'REQUEST' ? (
            <p className="text-sm text-muted-foreground">
              {t('Organized by')} {data.organizer.name ?? data.organizer.email}
            </p>
          ) : null}
          {replier ? (
            <p className="text-sm">
              {replier.name ?? replier.email}: {STATUS_LABELS[replier.status] ?? replier.status}
            </p>
          ) : null}
        </div>
      </div>

      {data.outdated ? <p className="mt-3 text-sm text-muted-foreground">{t('Your calendar has a newer version of this event.')}</p> : null}

      {data.method === 'REQUEST' && data.actionable && !data.outdated ? (
        <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label={t('Your answer')}>
          {ANSWERS.map(({ response, label }) => (
            <Button
              key={response}
              size="sm"
              variant={data.myStatus === response ? 'default' : 'outline'}
              aria-pressed={data.myStatus === response}
              disabled={answer.isPending}
              onClick={() => answer.mutate(response)}
            >
              {answer.isPending && answer.variables === response ? <Spinner /> : null}
              {label}
            </Button>
          ))}
          {data.myStatus && data.myStatus !== 'needs-action' ? (
            <span className="text-sm text-muted-foreground">
              {t('You answered:')} {STATUS_LABELS[data.myStatus] ?? data.myStatus}
            </span>
          ) : null}
        </div>
      ) : null}

      {data.method !== 'REQUEST' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {data.applied ? (
            <p className="text-sm text-muted-foreground" role="status">
              {data.method === 'CANCEL' ? 'Not in your calendar.' : 'Your calendar is up to date.'}
            </p>
          ) : data.actionable ? (
            <Button size="sm" variant="outline" disabled={apply.isPending} onClick={() => apply.mutate()}>
              {apply.isPending ? <Spinner /> : null}
              {data.method === 'CANCEL' ? 'Remove from calendar' : 'Update calendar'}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">{t('This message does not match an event in your calendar.')}</p>
          )}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {errorMessage(error)}
        </p>
      ) : null}
    </section>
  );
}
