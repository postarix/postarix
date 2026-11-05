import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, MailOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { Composer, type SenderOption } from '@/components/composer';
import { MessageList } from '@/components/message-list';
import { MessageView } from '@/components/message-view';
import { Sidebar } from '@/components/sidebar';
import { type DraftInput, emptyDraft, forwardDraft, replyDraft } from '@/lib/compose';
import { jmap } from '@/lib/jmap';
import { keys, useDeleteLabel, useIdentities, useLabels, useMailAccounts } from '@/lib/mail';
import { labelPath, mailboxPath, navigate } from '@/lib/router';
import { cn } from '@postarix/ui/lib/utils';
import { t } from '@/lib/i18n';

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
  const fromName = identities.data?.name ?? '';
  const sharedSenders = identities.data?.shared ?? [];
  const senders: SenderOption[] = [
    ...own.map((address) => ({ address, name: fromName })),
    ...sharedSenders.map((s) => ({ address: s.address, name: s.name, accountId: s.accountId })),
  ];
  /** Who a new message is from: the shared mailbox open (when the person may send from it), else their own address. */
  const fromFor = (accountId?: string): { address: string; draft: Partial<DraftInput> } => {
    const shared = accountId ? sharedSenders.find((s) => s.accountId === accountId) : undefined;
    return shared ? { address: shared.address, draft: { accountId: shared.accountId, fromName: shared.name } } : { address: defaultFrom, draft: {} };
  };
  const draftFrom = (accountId?: string): DraftInput => {
    const from = fromFor(accountId);
    return { ...emptyDraft(from.address), ...from.draft };
  };

  const element = (
    <>
      {draft ? (
        <Composer
          initial={draft}
          identities={senders}
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
  // Every draft carries the sender's name, so recipients see "Name <address>".
  const open = (next: DraftInput) => setDraft({ ...next, fromName: next.fromName ?? fromName });
  return { element, open, own, defaultFrom, fromFor, draftFrom };
}

export function MailPage({
  mailboxId,
  emailId,
  search,
  label: labelKeyword = null,
  email,
  name,
}: {
  mailboxId: string | null;
  emailId: string | null;
  search: string;
  label?: string | null;
  email: string;
  name: string;
}) {
  const mailAccounts = useMailAccounts();
  const labels = useLabels();
  const deleteLabel = useDeleteLabel();
  const composer = useComposer(email);
  usePush();

  const accounts = mailAccounts.data ?? [];
  const list = accounts.find((a) => a.personal)?.folders ?? [];
  const sharedAccounts = accounts.filter((a) => !a.personal);
  const inbox = list.find((m) => m.role === 'inbox');
  const label = labelKeyword ? (labels.data ?? []).find((l) => l.keyword === labelKeyword) ?? null : null;
  const allFolders = accounts.flatMap((a) => a.folders);
  const current = label ? inbox : (allFolders.find((m) => m.id === mailboxId) ?? (mailboxId === null ? inbox : undefined));
  // The account of the open folder: the person's own, or a shared mailbox.
  const currentAccount = accounts.find((a) => a.id === current?.accountId);
  const inShared = Boolean(currentAccount && !currentAccount.personal);
  const exclude = list.filter((m) => m.role === 'trash' || m.role === 'junk').map((m) => m.id);
  const listPath = (id: string | null) => (label ? labelPath(label.keyword, id, search) : mailboxPath(current?.id ?? '', id, search));

  useEffect(() => {
    if (mailboxId === null && !labelKeyword && inbox) navigate(mailboxPath(inbox.id), true);
  }, [mailboxId, labelKeyword, inbox]);

  return (
    <AppShell
      email={email}
      name={name}
      nav={
        <Sidebar
          mailboxes={list}
          shared={sharedAccounts}
          loading={mailAccounts.isLoading}
          currentId={label ? null : (current?.id ?? null)}
          labels={labels.data ?? []}
          currentLabel={label?.keyword ?? null}
          onDeleteLabel={(l) => {
            if (window.confirm(`Remove the label “${l.name}”? Messages keep their folders.`)) {
              deleteLabel.mutate(l.id);
              if (l.keyword === label?.keyword && inbox) navigate(mailboxPath(inbox.id));
            }
          }}
          onCompose={() => composer.open(composer.draftFrom(inShared ? currentAccount?.id : undefined))}
        />
      }
    >
      <div className="flex h-full min-h-0">
        <section className={cn('min-h-0 w-full border-r lg:w-[24rem] lg:shrink-0', emailId && 'max-lg:hidden')} aria-label={t('Message list')}>
          <MessageList
            key={`${label?.keyword ?? current?.id}:${search}`}
            mailbox={label ? undefined : current}
            accountName={inShared ? currentAccount?.name : undefined}
            label={label}
            labels={labels.data ?? []}
            exclude={exclude}
            search={search}
            selectedId={emailId}
          />
        </section>

        <section className={cn('min-h-0 min-w-0 flex-1', !emailId && 'max-lg:hidden')} aria-label={t('Reading pane')}>
          {emailId && current ? (
            <MessageView
              key={emailId}
              emailId={emailId}
              mailbox={current}
              mailboxes={currentAccount?.folders ?? list}
              shared={inShared}
              readOnly={Boolean(currentAccount?.readOnly)}
              labels={labels.data ?? []}
              search={search}
              backPath={listPath(null)}
              pathFor={(id) => listPath(id)}
              onReply={(message, all) => {
                const from = composer.fromFor(inShared ? currentAccount?.id : undefined);
                composer.open({ ...replyDraft(message, from.address, all, [...composer.own, from.address]), ...from.draft });
              }}
              onForward={(message) => {
                const from = composer.fromFor(inShared ? currentAccount?.id : undefined);
                composer.open({ ...forwardDraft(message, from.address), ...from.draft });
              }}
            />
          ) : (
            <div className="grid h-full place-items-center p-8">
              <div className="text-center text-muted-foreground">
                <MailOpen className="mx-auto mb-3 size-10 stroke-[1.25] text-muted-foreground/40" aria-hidden />
                <p className="text-sm">{t('Pick a message to read it here.')}</p>
              </div>
            </div>
          )}
        </section>
      </div>
      {composer.element}
    </AppShell>
  );
}
