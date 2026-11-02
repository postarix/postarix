import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, MailOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { Composer } from '@/components/composer';
import { MessageList } from '@/components/message-list';
import { MessageView } from '@/components/message-view';
import { Sidebar } from '@/components/sidebar';
import { type DraftInput, emptyDraft, forwardDraft, replyDraft } from '@/lib/compose';
import { jmap } from '@/lib/jmap';
import { keys, useIdentities, useMailboxes } from '@/lib/mail';
import { mailboxPath, navigate } from '@/lib/router';
import { cn } from '@postarix/ui/lib/utils';

/** Refreshes lists when the server reports changes (JMAP push over server-sent events). */
function usePush() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let source: EventSource | null = null;
    let cancelled = false;
    void jmap.eventSourceUrl(['Email', 'Mailbox', 'CalendarEvent', 'Contact']).then((url) => {
      if (cancelled) return;
      source = new EventSource(url, { withCredentials: true });
      source.addEventListener('state', () => {
        void queryClient.invalidateQueries({ queryKey: keys.allEmails });
        void queryClient.invalidateQueries({ queryKey: keys.mailboxes });
        void queryClient.invalidateQueries({ queryKey: ['events'] });
        void queryClient.invalidateQueries({ queryKey: ['contacts'] });
      });
    });
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [queryClient]);
}

/** The composer, opened from anywhere in the app (mail, contacts). */
export function useComposer(email: string) {
  const identities = useIdentities();
  const [draft, setDraft] = useState<DraftInput | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const own = identities.data?.addresses ?? [email];
  const defaultFrom = identities.data?.address ?? email;

  const element = (
    <>
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
        <div
          role="status"
          className="fixed right-5 bottom-5 z-50 flex items-center gap-2 rounded-lg border bg-popover px-4 py-3 text-sm font-medium text-popover-foreground shadow-lg"
        >
          <CircleCheck className="size-4 text-success" aria-hidden />
          {notice}
        </div>
      ) : null}
    </>
  );
  return { element, open: setDraft, own, defaultFrom };
}

export function MailPage({
  mailboxId,
  emailId,
  search,
  email,
  name,
}: {
  mailboxId: string | null;
  emailId: string | null;
  search: string;
  email: string;
  name: string;
}) {
  const mailboxes = useMailboxes();
  const composer = useComposer(email);
  usePush();

  const list = mailboxes.data ?? [];
  const inbox = list.find((m) => m.role === 'inbox');
  const current = list.find((m) => m.id === mailboxId) ?? (mailboxId === null ? inbox : undefined);

  useEffect(() => {
    if (mailboxId === null && inbox) navigate(mailboxPath(inbox.id), true);
  }, [mailboxId, inbox]);

  return (
    <AppShell
      email={email}
      name={name}
      nav={<Sidebar mailboxes={list} loading={mailboxes.isLoading} currentId={current?.id ?? null} onCompose={() => composer.open(emptyDraft(composer.defaultFrom))} />}
    >
      <div className="flex h-full min-h-0">
        <section className={cn('min-h-0 w-full border-r lg:w-[24rem] lg:shrink-0', emailId && 'max-lg:hidden')} aria-label="Message list">
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
              onReply={(message, all) => composer.open(replyDraft(message, composer.defaultFrom, all, composer.own))}
              onForward={(message) => composer.open(forwardDraft(message, composer.defaultFrom))}
            />
          ) : (
            <div className="grid h-full place-items-center p-8">
              <div className="text-center text-muted-foreground">
                <MailOpen className="mx-auto mb-3 size-10 stroke-[1.25] text-muted-foreground/40" aria-hidden />
                <p className="text-sm">Pick a message to read it here.</p>
              </div>
            </div>
          )}
        </section>
      </div>
      {composer.element}
    </AppShell>
  );
}
