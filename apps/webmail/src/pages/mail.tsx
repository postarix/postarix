import { Button } from '@postarix/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@postarix/ui/components/dropdown-menu';
import { cn } from '@postarix/ui/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, LogOut, Mail, Menu, Settings, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Composer } from '@/components/composer';
import { MessageList } from '@/components/message-list';
import { MessageView } from '@/components/message-view';
import { Sidebar } from '@/components/sidebar';
import { authClient } from '@/lib/auth-client';
import { type DraftInput, emptyDraft, forwardDraft, replyDraft } from '@/lib/compose';
import { jmap } from '@/lib/jmap';
import { keys, useIdentities, useMailboxes } from '@/lib/mail';
import { mailboxPath, navigate } from '@/lib/router';

/** Refreshes lists when the server reports changes (JMAP push over server-sent events). */
function usePush() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let source: EventSource | null = null;
    let cancelled = false;
    void jmap.eventSourceUrl(['Email', 'Mailbox']).then((url) => {
      if (cancelled) return;
      source = new EventSource(url, { withCredentials: true });
      source.addEventListener('state', () => {
        void queryClient.invalidateQueries({ queryKey: keys.allEmails });
        void queryClient.invalidateQueries({ queryKey: keys.mailboxes });
      });
    });
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [queryClient]);
}

export function MailPage({ mailboxId, emailId, search, email }: { mailboxId: string | null; emailId: string | null; search: string; email: string }) {
  const mailboxes = useMailboxes();
  const identities = useIdentities();
  const [draft, setDraft] = useState<DraftInput | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  usePush();

  const list = mailboxes.data ?? [];
  const inbox = list.find((m) => m.role === 'inbox');
  const current = list.find((m) => m.id === mailboxId) ?? (mailboxId === null ? inbox : undefined);

  useEffect(() => {
    if (mailboxId === null && inbox) navigate(mailboxPath(inbox.id), true);
  }, [mailboxId, inbox]);
  useEffect(() => setMenuOpen(false), [mailboxId]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const own = identities.data?.addresses ?? [email];
  const defaultFrom = identities.data?.address ?? email;
  const signOut = async () => {
    await authClient.signOut();
    window.location.assign('/login');
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-3 py-2">
        <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Folders" onClick={() => setMenuOpen((v) => !v)}>
          <Menu aria-hidden />
        </Button>
        <a data-nav href="/" className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <Mail className="size-4" aria-hidden />
          </span>
          <span className="font-semibold">Postarix Mail</span>
        </a>
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Account">
                <UserRound aria-hidden />
                <span className="hidden max-w-56 truncate sm:inline">{email}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="truncate">{email}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a href="/admin/account">
                  <Settings aria-hidden />
                  Security and app passwords
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void signOut()}>
                <LogOut aria-hidden />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <aside
          className={cn(
            'w-60 shrink-0 border-r bg-sidebar p-3',
            'max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-20 max-md:shadow-lg',
            !menuOpen && 'max-md:hidden',
          )}
        >
          <Sidebar mailboxes={list} loading={mailboxes.isLoading} currentId={current?.id ?? null} onCompose={() => setDraft(emptyDraft(defaultFrom))} />
        </aside>

        <section className={cn('min-h-0 w-full border-r lg:w-96 lg:shrink-0', emailId && 'max-lg:hidden')} aria-label="Message list">
          <MessageList key={`${current?.id}:${search}`} mailbox={current} search={search} selectedId={emailId} />
        </section>

        <section className={cn('min-h-0 min-w-0 flex-1', !emailId && 'max-lg:hidden')} aria-label="Reading pane">
          {emailId && current ? (
            <MessageView
              key={emailId}
              emailId={emailId}
              mailbox={current}
              mailboxes={list}
              search={search}
              onReply={(message, all) => setDraft(replyDraft(message, defaultFrom, all, own))}
              onForward={(message) => setDraft(forwardDraft(message, defaultFrom))}
            />
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">Select a message to read it.</div>
          )}
        </section>
      </div>

      {draft ? (
        <Composer
          initial={draft}
          identities={own}
          onClose={() => setDraft(null)}
          onSent={() => {
            setDraft(null);
            setNotice('Message sent.');
          }}
        />
      ) : null}
      {notice ? (
        <div role="status" className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-md bg-foreground px-4 py-2 text-sm text-background shadow-lg">
          <CircleCheck className="size-4" aria-hidden />
          {notice}
        </div>
      ) : null}
    </div>
  );
}
