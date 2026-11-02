import type { Mailbox } from '@postarix/jmap-client';
import { Button } from '@postarix/ui/components/button';
import { cn } from '@postarix/ui/lib/utils';
import { Archive, File, Folder, Inbox, PenLine, Send, ShieldAlert, Tag, Trash2, X } from 'lucide-react';
import type { Label } from '@/lib/mail';
import { labelPath, mailboxPath } from '@/lib/router';

const ICONS = { inbox: Inbox, drafts: File, sent: Send, archive: Archive, junk: ShieldAlert, trash: Trash2 } as const;

/** The folders of the mailbox, on the ink sidebar, with Compose as the one yellow action. */
export function Sidebar({
  mailboxes,
  loading,
  currentId,
  labels = [],
  currentLabel = null,
  onDeleteLabel,
  onCompose,
}: {
  mailboxes: Mailbox[];
  loading: boolean;
  currentId: string | null;
  labels?: Label[];
  currentLabel?: string | null;
  onDeleteLabel?: (label: Label) => void;
  onCompose: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-4">
      <Button variant="stamp" onClick={onCompose} className="h-9 w-full justify-start">
        <PenLine aria-hidden />
        Compose
      </Button>
      <nav aria-label="Folders" className="-mx-1 flex-1 overflow-y-auto px-1">
        {loading ? (
          <div className="space-y-1.5" aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-8 animate-pulse rounded-md bg-sidebar-accent/60" />
            ))}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {mailboxes.map((mailbox, index) => {
              const Icon = (mailbox.role && ICONS[mailbox.role as keyof typeof ICONS]) || Folder;
              const active = mailbox.id === currentId;
              const showUnread = mailbox.unreadEmails > 0 && mailbox.role !== 'sent' && mailbox.role !== 'drafts' && mailbox.role !== 'trash';
              const firstCustom = !mailbox.role && (index === 0 || Boolean(mailboxes[index - 1]!.role));
              return (
                <li key={mailbox.id}>
                  {firstCustom ? <p className="px-2.5 pt-4 pb-1.5 text-xs font-medium text-sidebar-muted">Folders</p> : null}
                  <a
                    data-nav
                    href={mailboxPath(mailbox.id)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors',
                      'focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none',
                      active ? 'bg-sidebar-accent font-medium text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.07),0_1px_2px_rgb(0_0_0/0.35)]' : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-white',
                    )}
                  >
                    <Icon className={cn('size-4 shrink-0', active ? 'text-stamp' : 'text-sidebar-muted group-hover:text-sidebar-foreground')} aria-hidden />
                    <span className="flex-1 truncate">{mailbox.name}</span>
                    {showUnread ? (
                      <span
                        className={cn(
                          'min-w-5 rounded-md px-1.5 text-center text-[0.7rem] leading-5 font-semibold tabular-nums',
                          mailbox.role === 'inbox' ? 'depth-stamp bg-stamp text-stamp-foreground' : 'text-sidebar-muted',
                        )}
                        aria-label={`${mailbox.unreadEmails} unread`}
                      >
                        {mailbox.unreadEmails}
                      </span>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        {labels.length ? (
          <>
            <p className="px-2.5 pt-4 pb-1.5 text-xs font-medium text-sidebar-muted">Labels</p>
            <ul className="space-y-0.5" aria-label="Labels">
              {labels.map((label) => {
                const active = label.keyword === currentLabel;
                return (
                  <li key={label.id} className="group/label relative">
                    <a
                      data-nav
                      href={labelPath(label.keyword)}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'group flex h-8 items-center gap-2.5 rounded-md px-2.5 pr-8 text-sm transition-colors',
                        'focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none',
                        active ? 'bg-sidebar-accent font-medium text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.07),0_1px_2px_rgb(0_0_0/0.35)]' : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-white',
                      )}
                    >
                      <Tag className={cn('size-4 shrink-0', active ? 'text-stamp' : 'text-sidebar-muted group-hover:text-sidebar-foreground')} aria-hidden />
                      <span className="flex-1 truncate">{label.name}</span>
                    </a>
                    {onDeleteLabel ? (
                      <button
                        type="button"
                        aria-label={`Remove label ${label.name}`}
                        onClick={() => onDeleteLabel(label)}
                        className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded text-sidebar-muted opacity-0 group-hover/label:opacity-100 hover:bg-sidebar-accent hover:text-white focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
                      >
                        <X className="size-3.5" aria-hidden />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </nav>
    </div>
  );
}
