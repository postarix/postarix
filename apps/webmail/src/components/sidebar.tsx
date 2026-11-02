import type { Mailbox } from '@postarix/jmap-client';
import { Button } from '@postarix/ui/components/button';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { cn } from '@postarix/ui/lib/utils';
import { Archive, File, Folder, Inbox, PenSquare, Send, ShieldAlert, Trash2 } from 'lucide-react';
import { mailboxPath } from '@/lib/router';

const ICONS = { inbox: Inbox, drafts: File, sent: Send, archive: Archive, junk: ShieldAlert, trash: Trash2 } as const;

export function Sidebar({
  mailboxes,
  loading,
  currentId,
  onCompose,
}: {
  mailboxes: Mailbox[];
  loading: boolean;
  currentId: string | null;
  onCompose: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-3">
      <Button onClick={onCompose} className="w-full">
        <PenSquare aria-hidden />
        Compose
      </Button>
      <nav aria-label="Folders" className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {mailboxes.map((mailbox) => {
              const Icon = (mailbox.role && ICONS[mailbox.role as keyof typeof ICONS]) || Folder;
              const active = mailbox.id === currentId;
              return (
                <li key={mailbox.id}>
                  <a
                    data-nav
                    href={mailboxPath(mailbox.id)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                      active ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground' : 'hover:bg-sidebar-accent/60',
                    )}
                  >
                    <Icon className="size-4 shrink-0 opacity-70" aria-hidden />
                    <span className="flex-1 truncate">{mailbox.name}</span>
                    {mailbox.unreadEmails > 0 && mailbox.role !== 'sent' && mailbox.role !== 'drafts' ? (
                      <span className="text-xs font-semibold tabular-nums" aria-label={`${mailbox.unreadEmails} unread`}>
                        {mailbox.unreadEmails}
                      </span>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </div>
  );
}
