import type { Email, Mailbox } from '@postarix/jmap-client';
import { Button } from '@postarix/ui/components/button';
import { Input } from '@postarix/ui/components/input';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { Spinner } from '@postarix/ui/components/spinner';
import { cn } from '@postarix/ui/lib/utils';
import { Flag, Paperclip, Search } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { displayName, shortDate } from '@/lib/format';
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
      <div className="border-b p-3">
        <form onSubmit={submit} role="search" className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${mailbox?.name ?? 'mail'}`}
            aria-label="Search mail"
            className="pl-8"
          />
        </form>
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {mailbox?.name}
            {search ? ` · results for “${search}”` : ''}
          </span>
          {emails.data ? <span>{emails.data.pages[0]?.total ?? 0} messages</span> : null}
        </div>
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
          <p className="p-8 text-center text-sm text-muted-foreground">{search ? 'No messages match your search.' : 'No messages here.'}</p>
        ) : (
          <ul aria-label="Messages">
            {list.map((email) => {
              const unread = !email.keywords.$seen;
              const people = showRecipients ? (email.to ?? []).map(displayName).join(', ') : displayName(email.from?.[0]);
              return (
                <li key={email.id}>
                  <a
                    data-nav
                    href={mailboxPath(mailbox.id, email.id, search)}
                    aria-current={email.id === selectedId ? 'true' : undefined}
                    className={cn(
                      'block border-b px-3 py-2.5 transition-colors hover:bg-accent/60',
                      email.id === selectedId && 'bg-accent',
                    )}
                  >
                    <div className="flex items-baseline gap-2">
                      {unread ? <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" /> : null}
                      <span className={cn('flex-1 truncate text-sm', unread && 'font-semibold')}>{people || '(no sender)'}</span>
                      {email.keywords.$flagged ? <Flag className="size-3.5 shrink-0 text-warning" aria-label="Flagged" /> : null}
                      {email.hasAttachment ? <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label="Has attachments" /> : null}
                      <time className="shrink-0 text-xs text-muted-foreground" dateTime={email.receivedAt}>
                        {shortDate(email.receivedAt)}
                      </time>
                    </div>
                    <p className={cn('truncate text-sm', unread ? 'font-medium' : 'text-foreground/90')}>{email.subject || '(no subject)'}</p>
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
