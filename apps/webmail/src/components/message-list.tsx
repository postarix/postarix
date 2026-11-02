import type { Email, Mailbox } from '@postarix/jmap-client';
import { Button } from '@postarix/ui/components/button';
import { Input } from '@postarix/ui/components/input';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { Spinner } from '@postarix/ui/components/spinner';
import { cn } from '@postarix/ui/lib/utils';
import { Flag, Paperclip, Search } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { dayGroup, displayName, shortDate } from '@/lib/format';
import { useEmails } from '@/lib/mail';
import { mailboxPath, navigate } from '@/lib/router';

export function MessageList({
  mailbox,
  search,
  selectedId,
}: {
  mailbox: Mailbox | undefined;
  search: string;
  selectedId: string | null;
}) {
  const emails = useEmails(mailbox?.id ?? null, search);
  const [query, setQuery] = useState(search);
  const list: Email[] = emails.data?.pages.flatMap((p) => p.emails) ?? [];
  const showRecipients = mailbox?.role === 'sent' || mailbox?.role === 'drafts';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mailbox) navigate(mailboxPath(mailbox.id, null, query));
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-4 pt-4 pb-2">
        <h1 className="mb-3 text-2xl font-semibold">{mailbox?.name ?? 'Mail'}</h1>
        <form onSubmit={submit} role="search" className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${mailbox?.name ?? 'mail'}`}
            aria-label="Search mail"
            className="h-10 rounded-full border-transparent bg-card pl-9 shadow-[0_1px_2px_rgb(22_33_61/0.06)] focus-visible:border-ring"
          />
        </form>
        <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
          {emails.data
            ? search
              ? `${emails.data.pages[0]?.total ?? 0} found for “${search}”`
              : `${emails.data.pages[0]?.total ?? 0} messages`
            : '\u00a0'}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {emails.isLoading || !mailbox ? (
          <div className="space-y-px">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="space-y-2 p-3">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-5/6" />
              </div>
            ))}
          </div>
        ) : emails.error ? (
          <p className="p-4 text-sm text-destructive">{errorMessage(emails.error)}</p>
        ) : list.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <p className="font-display text-lg font-semibold">{search ? 'Nothing matches' : 'Nothing here'}</p>
            <p className="mt-1 text-sm text-muted-foreground">{search ? 'Try other words, or search another folder.' : 'Mail that lands in this folder shows up here.'}</p>
          </div>
        ) : (
          <ul aria-label="Messages">
            {list.map((email, index) => {
              const unread = !email.keywords.$seen;
              const selected = email.id === selectedId;
              const people = showRecipients ? (email.to ?? []).map(displayName).join(', ') : displayName(email.from?.[0]);
              const group = dayGroup(email.receivedAt);
              const newGroup = index === 0 || dayGroup(list[index - 1]!.receivedAt) !== group;
              return (
                <li key={email.id}>
                  {newGroup ? (
                    <div className="sticky top-0 z-[1] bg-background/95 px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground backdrop-blur" role="presentation">
                      {group}
                    </div>
                  ) : null}
                  <a
                    data-nav
                    href={mailboxPath(mailbox.id, email.id, search)}
                    aria-current={selected ? 'true' : undefined}
                    className={cn(
                      'relative mx-2 mb-0.5 block rounded-lg px-3 py-2.5 transition-colors',
                      'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      selected ? 'bg-stamp-soft' : 'hover:bg-card',
                    )}
                  >
                    {selected ? <span className="absolute inset-y-2 left-0 w-1 rounded-full bg-stamp" aria-hidden /> : null}
                    <div className="flex items-baseline gap-2">
                      <span className={cn('flex-1 truncate text-sm', unread ? 'font-semibold text-foreground' : 'text-foreground/80')}>
                        {people || '(no sender)'}
                      </span>
                      {email.keywords.$flagged ? <Flag className="size-3.5 shrink-0 fill-current text-airmail-red" aria-label="Flagged" /> : null}
                      {email.hasAttachment ? <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label="Has attachments" /> : null}
                      <time className={cn('shrink-0 text-xs tabular-nums', unread ? 'font-semibold text-foreground' : 'text-muted-foreground')} dateTime={email.receivedAt}>
                        {shortDate(email.receivedAt)}
                      </time>
                    </div>
                    <p className={cn('flex items-center gap-1.5 truncate text-sm', unread ? 'font-medium text-foreground' : 'text-foreground/75')}>
                      {unread ? <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" /> : null}
                      <span className="truncate">{email.subject || '(no subject)'}</span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{email.preview}</p>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        {emails.hasNextPage ? (
          <div className="p-3 text-center">
            <Button variant="outline" size="sm" disabled={emails.isFetchingNextPage} onClick={() => void emails.fetchNextPage()}>
              {emails.isFetchingNextPage ? <Spinner /> : null}
              Load more
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
