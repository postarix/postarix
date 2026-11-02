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
  const [unreadOnly, setUnreadOnly] = useState(false);
  const all: Email[] = emails.data?.pages.flatMap((p) => p.emails) ?? [];
  const list = unreadOnly ? all.filter((e) => !e.keywords.$seen) : all;
  const showRecipients = mailbox?.role === 'sent' || mailbox?.role === 'drafts';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mailbox) navigate(mailboxPath(mailbox.id, null, query));
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <h1 className="flex-1 truncate text-lg font-semibold">{mailbox?.name ?? 'Mail'}</h1>
        <div role="group" aria-label="Show" className="inline-flex rounded-lg bg-muted p-0.5 text-xs font-medium">
          {[
            { label: 'All', value: false },
            { label: 'Unread', value: true },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={unreadOnly === option.value}
              onClick={() => setUnreadOnly(option.value)}
              className={cn(
                'rounded-md px-2.5 py-1 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                unreadOnly === option.value ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="px-4 pt-3 pb-2">
        <form onSubmit={submit} role="search" className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${mailbox?.name ?? 'mail'}`}
            aria-label="Search mail"
            className="h-9 bg-background pl-9 shadow-none"
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
            <p className="font-medium">{search ? 'Nothing matches' : unreadOnly ? 'All caught up' : 'Nothing here'}</p>
            <p className="mt-1 text-sm text-muted-foreground">{search ? 'Try other words, or search another folder.' : 'Mail that lands in this folder shows up here.'}</p>
          </div>
        ) : (
          <ul aria-label="Messages" className="space-y-2 px-3 pb-3">
            {list.map((email, index) => {
              const unread = !email.keywords.$seen;
              const selected = email.id === selectedId;
              const people = showRecipients ? (email.to ?? []).map(displayName).join(', ') : displayName(email.from?.[0]);
              const group = dayGroup(email.receivedAt);
              const newGroup = index === 0 || dayGroup(list[index - 1]!.receivedAt) !== group;
              return (
                <li key={email.id}>
                  {newGroup ? (
                    <div className="sticky top-0 z-[1] -mx-3 bg-card/90 px-4 pt-2 pb-1.5 text-xs font-medium text-muted-foreground backdrop-blur" role="presentation">
                      {group}
                    </div>
                  ) : null}
                  <a
                    data-nav
                    href={mailboxPath(mailbox.id, email.id, search)}
                    aria-current={selected ? 'true' : undefined}
                    className={cn(
                      'block rounded-lg border p-3 text-left transition-colors',
                      'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      selected ? 'border-primary/15 bg-accent shadow-xs' : 'border-border/70 bg-card hover:bg-muted/60',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {unread ? <span className="size-2 shrink-0 rounded-full bg-ink" aria-label="Unread" /> : null}
                      <span className={cn('flex-1 truncate text-sm', unread ? 'font-semibold' : 'font-medium text-foreground/85')}>
                        {people || '(no sender)'}
                      </span>
                      {email.keywords.$flagged ? <Flag className="size-3.5 shrink-0 fill-current text-destructive" aria-label="Flagged" /> : null}
                      <time className={cn('shrink-0 text-xs tabular-nums', unread ? 'font-medium text-foreground' : 'text-muted-foreground')} dateTime={email.receivedAt}>
                        {shortDate(email.receivedAt)}
                      </time>
                    </div>
                    <p className={cn('mt-0.5 truncate text-[0.8125rem]', unread ? 'font-medium text-foreground' : 'text-foreground/80')}>
                      {email.subject || '(no subject)'}
                    </p>
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{email.preview}</p>
                    {email.hasAttachment ? (
                      <span className="mt-2 inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">
                        <Paperclip className="size-3" aria-label="Has attachments" />
                        Attachment
                      </span>
                    ) : null}
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
