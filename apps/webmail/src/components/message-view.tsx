import type { Mailbox } from '@postarix/jmap-client';
import { Alert, AlertDescription } from '@postarix/ui/components/alert';
import { Button } from '@postarix/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@postarix/ui/components/dropdown-menu';
import { Separator } from '@postarix/ui/components/separator';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@postarix/ui/components/tooltip';
import { ArrowLeft, Archive, Download, Flag, FolderInput, Forward, ImageOff, Mail, MailOpen, Paperclip, Reply, ReplyAll, Trash2 } from 'lucide-react';
import { type ComponentProps, useEffect, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { addressList, displayName, formatBytes, longDate } from '@/lib/format';
import { jmap } from '@/lib/jmap';
import { type RenderedMessage, useMessage, useUpdateEmails } from '@/lib/mail';
import { mailboxPath, navigate } from '@/lib/router';
import { Avatar } from './avatar';
import { MessageFrame } from './message-frame';

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

export function MessageView({
  emailId,
  mailbox,
  mailboxes,
  search,
  onReply,
  onForward,
}: {
  emailId: string;
  mailbox: Mailbox;
  mailboxes: Mailbox[];
  search: string;
  onReply: (message: RenderedMessage, all: boolean) => void;
  onForward: (message: RenderedMessage) => void;
}) {
  const [remoteImages, setRemoteImages] = useState(false);
  const message = useMessage(emailId, remoteImages);
  const update = useUpdateEmails();
  const back = () => navigate(mailboxPath(mailbox.id, null, search));

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
        <Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label="Back to the list" onClick={back}>
          <ArrowLeft aria-hidden />
        </Button>
        {archive && mailbox.role !== 'archive' ? (
          <IconAction label="Archive" onClick={() => moveTo(archive)}>
            <Archive aria-hidden />
          </IconAction>
        ) : null}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Move to folder">
                  <FolderInput aria-hidden />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Move to folder</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Move to</DropdownMenuLabel>
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
        <IconAction
          label="Mark as unread"
          onClick={() => {
            update.mutate({ update: { [data.id]: { 'keywords/$seen': null } } });
            back();
          }}
        >
          {data.keywords.$seen ? <Mail aria-hidden /> : <MailOpen aria-hidden />}
        </IconAction>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => onReply(data, false)}>
            <Reply aria-hidden />
            Reply
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onReply(data, true)}>
            <ReplyAll aria-hidden />
            <span className="hidden xl:inline">Reply all</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onForward(data)}>
            <Forward aria-hidden />
            <span className="hidden xl:inline">Forward</span>
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-6 pb-8 md:px-8">
        <header className="space-y-5">
          <h2 className="text-xl leading-snug font-semibold break-words md:text-2xl">{data.subject || '(no subject)'}</h2>
          <div className="flex items-start gap-3">
            <Avatar name={displayName(data.from[0])} email={data.from[0]?.email ?? '?'} className="size-10" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-semibold">{displayName(data.from[0])}</span>
                {data.from[0]?.name ? <span className="truncate text-muted-foreground">{data.from[0].email}</span> : null}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                To {addressList(data.to)}
                {data.cc.length ? `, cc ${addressList(data.cc)}` : ''}
                {data.bcc.length ? `, bcc ${addressList(data.bcc)}` : ''}
              </p>
            </div>
            <time className="shrink-0 text-xs text-muted-foreground" dateTime={data.sentAt ?? data.receivedAt}>
              {longDate(data.sentAt ?? data.receivedAt)}
            </time>
          </div>
        </header>

        <Separator />

        {data.blockedImages > 0 ? (
          <Alert className="bg-muted/50">
            <ImageOff aria-hidden />
            <AlertDescription className="flex flex-wrap items-center gap-2">
              Remote images are blocked to protect your privacy ({data.blockedImages}).
              <Button size="xs" variant="outline" onClick={() => setRemoteImages(true)}>
                Show images
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {data.truncated ? <p className="text-xs text-muted-foreground">This message is very long; only the beginning is shown.</p> : null}

        <MessageFrame html={data.html} title={`Message: ${data.subject}`} />

        {data.attachments.length ? (
          <section aria-label="Attachments" className="grid gap-2 sm:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]">
            {data.attachments.map((a) => (
              <AttachmentLink key={a.blobId} attachment={a} />
            ))}
          </section>
        ) : null}
      </div>
    </article>
  );
}
