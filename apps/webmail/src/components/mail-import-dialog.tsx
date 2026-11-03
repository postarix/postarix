import { Button } from '@postarix/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@postarix/ui/components/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Spinner } from '@postarix/ui/components/spinner';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { knownServer, type MailImport, type MailImportInput, useCancelMailImport, useMailImports, useStartMailImport } from '@/lib/mail-import';
import { t } from '@/lib/i18n';

const STATUS: Record<MailImport['status'], string> = {
  queued: 'Waiting to start',
  running: 'Copying',
  done: 'Finished',
  failed: 'Stopped',
  cancelled: 'Cancelled',
};

function describe(item: MailImport): string {
  const counts = `${item.imported} ${item.imported === 1 ? 'message' : 'messages'} copied${item.skipped ? `, ${item.skipped} skipped` : ''}`;
  return `${STATUS[item.status]} · ${counts}`;
}

/** Copies the mail of another account (Gmail, an old provider…) into this mailbox, folders included. */
export function MailImportDialog({ onClose }: { onClose: () => void }) {
  const imports = useMailImports();
  const start = useStartMailImport();
  const cancel = useCancelMailImport();
  const [form, setForm] = useState<MailImportInput>({ host: '', security: 'tls', username: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const active = imports.data?.find((i) => i.status === 'queued' || i.status === 'running');
  const known = knownServer(form.username);

  const set = (patch: Partial<MailImportInput>) => setForm((f) => ({ ...f, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await start.mutateAsync({ ...form, host: form.host.trim() || known?.host || '', username: form.username.trim() });
      setForm((f) => ({ ...f, password: '' }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-xl">{t('Import mail')}</DialogTitle>
          <DialogDescription>{t('Copies the mail of another account into this one, folders included. Your old account is not changed, and the copy carries on while the webmail is closed.')}</DialogDescription>
        </DialogHeader>
        {imports.data?.length ? (
          <ul className="space-y-2" aria-label={t('Imports')}>
            {imports.data.slice(0, 5).map((item) => (
              <li key={item.id} className="flex items-start gap-3 rounded-md bg-muted px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{item.username}</span>
                  <span className="block text-muted-foreground">{describe(item)}</span>
                  {item.error ? <span className="block text-destructive">{item.error}</span> : null}
                </span>
                {item.status === 'queued' || item.status === 'running' ? (
                  <Button type="button" variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(item.id)}>{t('Cancel')}</Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {active ? null : (
          <form onSubmit={submit}>
            <FieldGroup className="gap-5">
              <FieldSet>
                <FieldLegend>{t('The other account')}</FieldLegend>
                <Field>
                  <FieldLabel htmlFor="import-user">{t('Email address or user name')}</FieldLabel>
                  <Input id="import-user" autoComplete="off" required maxLength={320} value={form.username} onChange={(e) => set({ username: e.target.value })} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="import-password">{t('Password')}</FieldLabel>
                  <Input id="import-password" type="password" autoComplete="off" required maxLength={1024} value={form.password} onChange={(e) => set({ password: e.target.value })} />
                  {known?.note ? <FieldDescription>{known.note}</FieldDescription> : null}
                </Field>
                <Field>
                  <FieldLabel htmlFor="import-host">{t('IMAP server')}</FieldLabel>
                  <Input id="import-host" placeholder={known?.host ?? 'imap.example.com'} maxLength={253} value={form.host} onChange={(e) => set({ host: e.target.value })} />
                  <FieldDescription>{known ? 'Filled in for you; change it only if your provider says so.' : 'Your old provider’s help pages give it.'}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="import-security">{t('Connection')}</FieldLabel>
                  <NativeSelect id="import-security" value={form.security} onChange={(e) => set({ security: e.target.value as MailImportInput['security'] })}>
                    <NativeSelectOption value="tls">{t('TLS (port 993)')}</NativeSelectOption>
                    <NativeSelectOption value="starttls">{t('STARTTLS (port 143)')}</NativeSelectOption>
                  </NativeSelect>
                </Field>
              </FieldSet>
              <p className="text-sm text-muted-foreground">{t('Microsoft 365 and Outlook.com accounts cannot be imported this way: they no longer accept passwords from other apps.')}</p>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={onClose}>{t('Close')}</Button>
                <Button type="submit" disabled={start.isPending || (!form.host.trim() && !known)}>
                  {start.isPending ? <Spinner /> : null}{t('Start import')}</Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        )}
        {active ? (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t('Close')}</Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
