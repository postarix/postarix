import type { Mailbox } from '@postarix/jmap-client';
import { Alert, AlertDescription } from '@postarix/ui/components/alert';
import { Button } from '@postarix/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@postarix/ui/components/dropdown-menu';
import { Input } from '@postarix/ui/components/input';
import { cn } from '@postarix/ui/lib/utils';
import { Separator } from '@postarix/ui/components/separator';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@postarix/ui/components/tooltip';
import { ArrowLeft, Archive, Download, Flag, FolderInput, Forward, ImageOff, Mail, MailOpen, Paperclip, Reply, ReplyAll, Tag, Trash2 } from 'lucide-react';
import { type ComponentProps, useEffect, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { addressList, displayName, formatBytes, longDate, shortDate } from '@/lib/format';
import { jmap } from '@/lib/jmap';
import { type Label, type RenderedMessage, useCreateLabel, useMessage, useThread, useUpdateEmails } from '@/lib/mail';
import { mailboxPath, navigate } from '@/lib/router';
import { Avatar } from './avatar';
import { InvitationCard } from './invitation-card';
import { MessageFrame } from './message-frame';
import { t } from '@/lib/i18n';

/** An icon-only toolbar button with a tooltip carrying its name. */
function IconAction({ label, children, ...props }: { label: string } & ComponentProps<typeof Button>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function AttachmentLink({ attachment }: { attachment: RenderedMessage['attachments'][number] }) {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    void jmap.downloadUrl(attachment.blobId, attachment.name, attachment.type).then(setHref);
  }, [attachment]);
  return (
    <a
      href={href ?? undefined}
      download={attachment.name}
      className="group flex max-w-full min-w-0 items-center gap-3 rounded-lg border bg-card p-2 pr-3 text-sm shadow-xs transition-colors hover:bg-muted/60"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent text-ink">
        <Paperclip className="size-4" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium">{attachment.name}</span>
        <span className="block text-xs text-muted-foreground">{formatBytes(attachment.size)}</span>
      </span>
      <Download className="ml-1 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden />
    </a>
  );
}

/** The other messages of the conversation, oldest first; the open one is marked. */
function Conversation({ threadId, currentId, pathFor }: { threadId: string; currentId: string; pathFor: (emailId: string) => string }) {
  const thread = useThread(threadId);
  const list = thread.data ?? [];
  if (list.length < 2) return null;
  return (
    <section aria-label={t('Conversation')} className="rounded-lg border bg-muted/30">
      <p className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">{list.length}{' '}{t('messages in this conversation')}</p>
      <ol>
        {list.map((m) => {
          const current = m.id === currentId;
          return (
            <li key={m.id} className="border-b last:border-b-0">
              <a
                data-nav
                href={pathFor(m.id)}
                aria-current={current ? 'true' : undefined}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  current ? 'bg-accent' : 'hover:bg-muted/60',
                )}
              >
                <span className={cn('w-36 shrink-0 truncate', !m.keywords.$seen && 'font-semibold')}>{displayName(m.from?.[0]) || '(no sender)'}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{m.preview}</span>
                <time className="shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={m.receivedAt}>
                  {shortDate(m.receivedAt)}
                </time>
              </a>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Puts labels on a message or takes them off; new labels can be made here. */
function LabelMenu({ message, labels, onToggle }: { message: RenderedMessage; labels: Label[]; onToggle: (keyword: string, on: boolean) => void }) {
  const create = useCreateLabel();
  const [name, setName] = useState('');
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('Labels')}>
              <Tag aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('Labels')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>{t('Labels')}</DropdownMenuLabel>
        {labels.map((l) => (
          <DropdownMenuCheckboxItem key={l.id} checked={Boolean(message.keywords[l.keyword])} onCheckedChange={(on) => onToggle(l.keyword, on === true)}>
            {l.name}
          </DropdownMenuCheckboxItem>
        ))}
        {labels.length ? <DropdownMenuSeparator /> : null}
        <form
          className="flex gap-1 p-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            void create.mutateAsync(name.trim()).then((label) => {
              onToggle(label.keyword, true);
              setName('');
            });
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder={t('New label')} aria-label={t('New label')} className="h-8" maxLength={40} />
          <Button type="submit" size="sm" variant="outline" disabled={create.isPending}>{t('Add')}</Button>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MessageView({
  emailId,
  mailbox,
  mailboxes,
  labels,
  search,
  backPath,
  pathFor,
  onReply,
  onForward,
}: {
  emailId: string;
  mailbox: Mailbox;
  mailboxes: Mailbox[];
  labels: Label[];
  search: string;
  /** Where "back" goes (the folder or label the message was opened from). */
  backPath?: string;
  /** The link to another message from the same list. */
  pathFor?: (emailId: string) => string;
  onReply: (message: RenderedMessage, all: boolean) => void;
  onForward: (message: RenderedMessage) => void;
}) {
  const [remoteImages, setRemoteImages] = useState(false);
  const message = useMessage(emailId, remoteImages);
  const update = useUpdateEmails();
  const back = () => navigate(backPath ?? mailboxPath(mailbox.id, null, search));
  const linkTo = pathFor ?? ((id: string) => mailboxPath(mailbox.id, id, search));

  useEffect(() => setRemoteImages(false), [emailId]);

  // Opening a message marks it read.
  const data = message.data;
  useEffect(() => {
    if (data && !data.keywords.$seen) update.mutate({ update: { [data.id]: { 'keywords/$seen': true } } });
  }, [data?.id]);

  if (message.isLoading) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (message.error || !data) {
    return <p className="p-6 text-sm text-destructive">{errorMessage(message.error ?? new Error('Message not found'))}</p>;
  }

  const trash = mailboxes.find((m) => m.role === 'trash');
  const archive = mailboxes.find((m) => m.role === 'archive');
  const moveTo = (target: Mailbox) => {
    update.mutate({ update: { [data.id]: { mailboxIds: { [target.id]: true } } } });
    back();
  };
  const remove = () => {
    if (mailbox.role === 'trash' || !trash) update.mutate({ destroy: [data.id] });
    else update.mutate({ update: { [data.id]: { mailboxIds: { [trash.id]: true } } } });
    back();
  };

  return (
    <article className="flex h-full min-h-0 flex-col" aria-label={data.subject || 'Message'}>
      <div className="flex h-14 shrink-0 items-center gap-1 border-b px-3 md:px-4">
        <Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label={t('Back to the list')} onClick={back}>
          <ArrowLeft aria-hidden />
        </Button>
        {archive && mailbox.role !== 'archive' ? (
          <IconAction label={t('Archive')} onClick={() => moveTo(archive)}>
            <Archive aria-hidden />
          </IconAction>
        ) : null}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('Move to folder')}>
                  <FolderInput aria-hidden />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t('Move to folder')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t('Move to')}</DropdownMenuLabel>
            {mailboxes
              .filter((m) => m.id !== mailbox.id && m.role !== 'drafts')
              .map((m) => (
                <DropdownMenuItem key={m.id} onSelect={() => moveTo(m)}>
                  {m.name}
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <IconAction label={mailbox.role === 'trash' ? 'Delete forever' : 'Delete'} onClick={remove}>
          <Trash2 aria-hidden />
        </IconAction>
        <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />
        <IconAction
          label={data.keywords.$flagged ? 'Remove flag' : 'Flag'}
          onClick={() => update.mutate({ update: { [data.id]: { 'keywords/$flagged': data.keywords.$flagged ? null : true } } })}
        >
          <Flag aria-hidden className={data.keywords.$flagged ? 'fill-current text-destructive' : undefined} />
        </IconAction>
        <LabelMenu
          message={data}
          labels={labels}
          onToggle={(keyword, on) => update.mutate({ update: { [data.id]: { [`keywords/${keyword}`]: on ? true : null } } })}
        />
        <IconAction
          label={t('Mark as unread')}
          onClick={() => {
            update.mutate({ update: { [data.id]: { 'keywords/$seen': null } } });
            back();
          }}
        >
          {data.keywords.$seen ? <Mail aria-hidden /> : <MailOpen aria-hidden />}
        </IconAction>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => onReply(data, false)}>
            <Reply aria-hidden />{t('Reply')}</Button>
          <Button variant="ghost" size="sm" onClick={() => onReply(data, true)}>
            <ReplyAll aria-hidden />
            <span className="hidden xl:inline">{t('Reply all')}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onForward(data)}>
            <Forward aria-hidden />
            <span className="hidden xl:inline">{t('Forward')}</span>
          </Button>
        </div>
      </div>

      <div className="scrollbar-stable relative flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-6 pb-8 md:px-8">
        <header className="space-y-5">
          <h2 className="text-xl leading-snug font-semibold break-words md:text-2xl">{data.subject || '(no subject)'}</h2>
          <div className="flex items-start gap-3">
            <Avatar name={displayName(data.from[0])} email={data.from[0]?.email ?? '?'} className="size-10" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-semibold">{displayName(data.from[0])}</span>
                {data.from[0]?.name ? <span className="truncate text-muted-foreground">{data.from[0].email}</span> : null}
              </p>
              <p className="truncate text-xs text-muted-foreground">{t('To')}{' '}{addressList(data.to)}
                {data.cc.length ? `, cc ${addressList(data.cc)}` : ''}
                {data.bcc.length ? `, bcc ${addressList(data.bcc)}` : ''}
              </p>
            </div>
            <time className="shrink-0 text-xs text-muted-foreground" dateTime={data.sentAt ?? data.receivedAt}>
              {longDate(data.sentAt ?? data.receivedAt)}
            </time>
          </div>
        </header>

        {labels.some((l) => data.keywords[l.keyword]) ? (
          <div className="-mt-2 flex flex-wrap gap-1.5" aria-label={t('Labels')}>
            {labels
              .filter((l) => data.keywords[l.keyword])
              .map((l) => (
                <span key={l.id} className="rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground ring-1 ring-ink/10 ring-inset">
                  {l.name}
                </span>
              ))}
          </div>
        ) : null}

        <Conversation threadId={data.threadId} currentId={data.id} pathFor={linkTo} />

        <Separator />

        {data.calendar ? <InvitationCard emailId={data.id} /> : null}

        {data.blockedImages > 0 ? (
          <Alert className="bg-muted/50">
            <ImageOff aria-hidden />
            <AlertDescription className="flex flex-wrap items-center gap-2">{t('Remote images are blocked to protect your privacy (')}{data.blockedImages}).
              <Button size="xs" variant="outline" onClick={() => setRemoteImages(true)}>{t('Show images')}</Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {data.truncated ? <p className="text-xs text-muted-foreground">{t('This message is very long; only the beginning is shown.')}</p> : null}

        <MessageFrame html={data.html} title={`Message: ${data.subject}`} />

        {data.attachments.length ? (
          <section aria-label={t('Attachments')} className="grid gap-2 sm:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]">
            {data.attachments.map((a) => (
              <AttachmentLink key={a.blobId} attachment={a} />
            ))}
          </section>
        ) : null}
      </div>
    </article>
  );
}
