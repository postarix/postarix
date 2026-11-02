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
import { Skeleton } from '@postarix/ui/components/skeleton';
import { ArrowLeft, Archive, Download, Flag, FolderInput, Forward, ImageOff, Mail, MailOpen, Paperclip, Reply, ReplyAll, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { addressList, displayName, formatBytes, longDate } from '@/lib/format';
import { jmap } from '@/lib/jmap';
import { type RenderedMessage, useMessage, useUpdateEmails } from '@/lib/mail';
import { mailboxPath, navigate } from '@/lib/router';
import { MessageFrame } from './message-frame';

function AttachmentLink({ attachment }: { attachment: RenderedMessage['attachments'][number] }) {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    void jmap.downloadUrl(attachment.blobId, attachment.name, attachment.type).then(setHref);
  }, [attachment]);
  return (
    <a
      href={href ?? undefined}
      download={attachment.name}
      className="inline-flex max-w-full items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
    >
      <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{attachment.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(attachment.size)}</span>
      <Download className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
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
      <div className="flex flex-wrap items-center gap-1 border-b p-2">
        <Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label="Back to the list" onClick={back}>
          <ArrowLeft aria-hidden />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onReply(data, false)}>
          <Reply aria-hidden />
          Reply
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onReply(data, true)}>
          <ReplyAll aria-hidden />
          <span className="hidden sm:inline">Reply all</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onForward(data)}>
          <Forward aria-hidden />
          <span className="hidden sm:inline">Forward</span>
        </Button>
        <div className="ml-auto flex items-center gap-1">
          {archive && mailbox.role !== 'archive' ? (
            <Button variant="ghost" size="icon-sm" aria-label="Archive" title="Archive" onClick={() => moveTo(archive)}>
              <Archive aria-hidden />
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Move to folder" title="Move to folder">
                <FolderInput aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
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
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={data.keywords.$flagged ? 'Remove flag' : 'Flag'}
            title={data.keywords.$flagged ? 'Remove flag' : 'Flag'}
            onClick={() => update.mutate({ update: { [data.id]: { 'keywords/$flagged': data.keywords.$flagged ? null : true } } })}
          >
            <Flag aria-hidden className={data.keywords.$flagged ? 'fill-current text-warning' : undefined} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Mark as unread"
            title="Mark as unread"
            onClick={() => {
              update.mutate({ update: { [data.id]: { 'keywords/$seen': null } } });
              back();
            }}
          >
            {data.keywords.$seen ? <Mail aria-hidden /> : <MailOpen aria-hidden />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={mailbox.role === 'trash' ? 'Delete forever' : 'Delete'}
            title={mailbox.role === 'trash' ? 'Delete forever' : 'Delete'}
            onClick={remove}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 md:p-6">
        <header className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight break-words">{data.subject || '(no subject)'}</h2>
          <p className="text-sm">
            <span className="font-medium">{displayName(data.from[0])}</span>{' '}
            {data.from[0]?.name ? <span className="text-muted-foreground">&lt;{data.from[0].email}&gt;</span> : null}
          </p>
          <p className="text-xs text-muted-foreground">
            To {addressList(data.to)}
            {data.cc.length ? ` · Cc ${addressList(data.cc)}` : ''}
            {data.bcc.length ? ` · Bcc ${addressList(data.bcc)}` : ''}
          </p>
          <p className="text-xs text-muted-foreground">{longDate(data.sentAt ?? data.receivedAt)}</p>
        </header>

        {data.blockedImages > 0 ? (
          <Alert>
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
          <section aria-label="Attachments" className="flex flex-wrap gap-2">
            {data.attachments.map((a) => (
              <AttachmentLink key={a.blobId} attachment={a} />
            ))}
          </section>
        ) : null}
      </div>
    </article>
  );
}
