import { Button } from '@postarix/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@postarix/ui/components/dialog';
import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Spinner } from '@postarix/ui/components/spinner';
import { Textarea } from '@postarix/ui/components/textarea';
import { useQueryClient } from '@tanstack/react-query';
import { Paperclip, Send, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { type Attachment, type DraftInput, saveDraft, sendDraft } from '@/lib/compose';
import { addressList, formatBytes, parseAddresses } from '@/lib/format';
import { jmap } from '@/lib/jmap';
import { keys } from '@/lib/mail';
import { RecipientInput } from './recipient-input';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const ROW = 'flex items-center gap-2 border-b px-5';
const LABEL = 'w-14 shrink-0 text-sm text-muted-foreground';
const BARE = 'h-11 rounded-none border-0 bg-transparent px-0 shadow-none! focus-visible:ring-0 dark:bg-transparent';

export function Composer({
  initial,
  identities,
  onClose,
  onSent,
}: {
  initial: DraftInput;
  identities: string[];
  onClose: () => void;
  onSent: () => void;
}) {
  const queryClient = useQueryClient();
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(addressList(initial.to));
  const [cc, setCc] = useState(addressList(initial.cc));
  const [bcc, setBcc] = useState(addressList(initial.bcc));
  const [showCopies, setShowCopies] = useState(initial.cc.length > 0 || initial.bcc.length > 0);
  const [subject, setSubject] = useState(initial.subject);
  const [text, setText] = useState(initial.text);
  const [attachments, setAttachments] = useState<Attachment[]>(initial.attachments);
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState<'send' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  function collect(): DraftInput | null {
    const parsed = { to: parseAddresses(to), cc: parseAddresses(cc), bcc: parseAddresses(bcc) };
    const invalid = [...parsed.to.invalid, ...parsed.cc.invalid, ...parsed.bcc.invalid];
    if (invalid.length) {
      setError(`Not an email address: ${invalid.join(', ')}`);
      return null;
    }
    return {
      ...initial,
      from,
      to: parsed.to.addresses,
      cc: parsed.cc.addresses,
      bcc: parsed.bcc.addresses,
      subject,
      text,
      attachments,
    };
  }

  async function run(kind: 'send' | 'save') {
    const draft = collect();
    if (!draft) return;
    if (kind === 'send' && draft.to.length + draft.cc.length + draft.bcc.length === 0) {
      setError('Add at least one recipient.');
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'send') await sendDraft(draft);
      else await saveDraft(draft);
      void queryClient.invalidateQueries({ queryKey: keys.allEmails });
      void queryClient.invalidateQueries({ queryKey: keys.mailboxes });
      if (kind === 'send') onSent();
      else onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function attach(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`${file.name} is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const blob = await jmap.upload(file);
        setAttachments((list) => [...list, { blobId: blob.blobId, name: file.name, type: file.type || blob.type, size: file.size }]);
      } catch (e) {
        setError(`Could not attach ${file.name}: ${errorMessage(e)}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="flex max-h-[92vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader className="border-b px-5 py-3.5 pr-12 text-left">
          <DialogTitle className="truncate text-base">{subject.trim() || 'New message'}</DialogTitle>
          <DialogDescription className="sr-only">Write and send an email</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          onSubmit={(e) => {
            e.preventDefault();
            void run('send');
          }}
        >
          {identities.length > 1 ? (
            <div className={ROW}>
              <label htmlFor={`${id}-from`} className={LABEL}>
                From
              </label>
              <NativeSelect id={`${id}-from`} value={from} onChange={(e) => setFrom(e.target.value)} className={`${BARE} w-full pr-8`}>
                {identities.map((address) => (
                  <NativeSelectOption key={address} value={address}>
                    {address}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          <div className={ROW}>
            <label htmlFor={`${id}-to`} className={LABEL}>
              To
            </label>
            <RecipientInput id={`${id}-to`} value={to} onChange={setTo} autoFocus={!to} placeholder="Name or address" className={BARE} />
            {!showCopies ? (
              <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setShowCopies(true)}>
                Cc/Bcc
              </Button>
            ) : null}
          </div>
          {showCopies ? (
            <>
              <div className={ROW}>
                <label htmlFor={`${id}-cc`} className={LABEL}>
                  Cc
                </label>
                <RecipientInput id={`${id}-cc`} value={cc} onChange={setCc} className={BARE} />
              </div>
              <div className={ROW}>
                <label htmlFor={`${id}-bcc`} className={LABEL}>
                  Bcc
                </label>
                <RecipientInput id={`${id}-bcc`} value={bcc} onChange={setBcc} className={BARE} />
              </div>
            </>
          ) : null}
          <div className={ROW}>
            <label htmlFor={`${id}-subject`} className={LABEL}>
              Subject
            </label>
            <Input id={`${id}-subject`} value={subject} onChange={(e) => setSubject(e.target.value)} className={BARE} />
          </div>
          <Textarea
            aria-label="Message"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus={Boolean(to)}
            placeholder="Write your message…"
            className={`${BARE} min-h-72 flex-1 resize-none px-5 py-4 text-[0.95rem] leading-relaxed`}
          />
          {attachments.length || uploading ? (
            <ul className="flex flex-wrap gap-2 px-5 pb-3" aria-label="Attachments">
              {attachments.map((a) => (
                <li key={a.blobId} className="inline-flex items-center gap-2 rounded-lg border bg-muted/40 py-1 pr-1 pl-2.5 text-sm">
                  <Paperclip className="size-3.5 text-muted-foreground" aria-hidden />
                  <span className="max-w-48 truncate">{a.name}</span>
                  <span className="text-xs text-muted-foreground">{formatBytes(a.size)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${a.name}`}
                    onClick={() => setAttachments((list) => list.filter((x) => x.blobId !== a.blobId))}
                  >
                    <X aria-hidden />
                  </Button>
                </li>
              ))}
              {uploading ? (
                <li className="inline-flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
                  <Spinner /> Uploading…
                </li>
              ) : null}
            </ul>
          ) : null}
          {error ? (
            <p role="alert" className="px-5 pb-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => void attach(e.target.files).then(() => (e.target.value = ''))} />
          <DialogFooter className="sticky bottom-0 items-center gap-2 border-t bg-card px-4 py-3 sm:justify-between">
            <Button type="button" variant="ghost" className="text-muted-foreground" onClick={() => fileInput.current?.click()} disabled={uploading > 0}>
              <Paperclip aria-hidden />
              Attach
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => void run('save')} disabled={busy !== null || uploading > 0}>
                {busy === 'save' ? <Spinner /> : null}
                Save draft
              </Button>
              <Button type="submit" variant="stamp" disabled={busy !== null || uploading > 0}>
                {busy === 'send' ? <Spinner /> : <Send aria-hidden />}
                Send
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
