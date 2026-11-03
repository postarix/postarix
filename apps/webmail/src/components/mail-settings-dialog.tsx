import { Button } from '@postarix/ui/components/button';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@postarix/ui/components/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { Spinner } from '@postarix/ui/components/spinner';
import { Textarea } from '@postarix/ui/components/textarea';
import { type FormEvent, useEffect, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { type MailSettings, useMailSettings, useSaveMailSettings } from '@/lib/mail-settings';
import { t } from '@/lib/i18n';

const blank: MailSettings = {
  filters: [],
  vacation: { enabled: false, subject: 'Out of office', message: '', until: null },
  forwarding: { enabled: false, address: '', keepCopy: true },
  taggedMail: 'inbox',
};

/** Automatic reply and forwarding, kept on the mail server for this mailbox. */
export function MailSettingsDialog({ onClose }: { onClose: () => void }) {
  const current = useMailSettings(true);
  const save = useSaveMailSettings();
  const [form, setForm] = useState<MailSettings>(blank);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (current.data) setForm({ filters: current.data.filters ?? [], vacation: current.data.vacation, forwarding: current.data.forwarding, taggedMail: current.data.taggedMail ?? 'inbox' });
  }, [current.data]);

  const vacation = (patch: Partial<MailSettings['vacation']>) => setForm((f) => ({ ...f, vacation: { ...f.vacation, ...patch } }));
  const forwarding = (patch: Partial<MailSettings['forwarding']>) => setForm((f) => ({ ...f, forwarding: { ...f.forwarding, ...patch } }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    if (form.vacation.enabled && !form.vacation.message.trim()) return setError('Write the automatic reply.');
    if (form.forwarding.enabled && !form.forwarding.address.trim()) return setError('Enter the address to forward to.');
    setError(null);
    try {
      await save.mutateAsync({ ...form, forwarding: { ...form.forwarding, address: form.forwarding.address.trim() } });
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-xl">{t('Automatic reply and forwarding')}</DialogTitle>
          <DialogDescription>{t('These work even while the webmail is closed.')}</DialogDescription>
        </DialogHeader>
        {current.isPending ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : current.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(current.error)}
          </p>
        ) : (
          <form onSubmit={submit}>
            <FieldGroup className="gap-5">
              <FieldSet>
                <FieldLegend>{t('Automatic reply')}</FieldLegend>
                <Field orientation="horizontal">
                  <Checkbox id="vacation-on" checked={form.vacation.enabled} onCheckedChange={(v) => vacation({ enabled: v === true })} />
                  <FieldLabel htmlFor="vacation-on" className="font-normal">{t('Reply to people who write to me')}</FieldLabel>
                </Field>
                <Field>
                  <FieldLabel htmlFor="vacation-subject">{t('Subject')}</FieldLabel>
                  <Input id="vacation-subject" maxLength={200} value={form.vacation.subject} disabled={!form.vacation.enabled} onChange={(e) => vacation({ subject: e.target.value })} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="vacation-message">{t('Message')}</FieldLabel>
                  <Textarea id="vacation-message" rows={4} maxLength={5000} value={form.vacation.message} disabled={!form.vacation.enabled} onChange={(e) => vacation({ message: e.target.value })} />
                  <FieldDescription>{t('Each person gets it at most once every three days.')}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="vacation-until">{t('Last day (optional)')}</FieldLabel>
                  <Input id="vacation-until" type="date" className="w-auto" value={form.vacation.until ?? ''} disabled={!form.vacation.enabled} onChange={(e) => vacation({ until: e.target.value || null })} />
                </Field>
              </FieldSet>
              <FieldSet>
                <FieldLegend>{t('Forwarding')}</FieldLegend>
                <Field orientation="horizontal">
                  <Checkbox id="forward-on" checked={form.forwarding.enabled} onCheckedChange={(v) => forwarding({ enabled: v === true })} />
                  <FieldLabel htmlFor="forward-on" className="font-normal">{t('Forward my mail')}</FieldLabel>
                </Field>
                <Field>
                  <FieldLabel htmlFor="forward-to">{t('To')}</FieldLabel>
                  <Input id="forward-to" type="email" placeholder={t('name@example.com')} value={form.forwarding.address} disabled={!form.forwarding.enabled} onChange={(e) => forwarding({ address: e.target.value })} />
                  <FieldDescription>{t('Spam is not forwarded, and at most 100 messages an hour are.')}</FieldDescription>
                </Field>
                <Field orientation="horizontal">
                  <Checkbox id="forward-keep" checked={form.forwarding.keepCopy} disabled={!form.forwarding.enabled} onCheckedChange={(v) => forwarding({ keepCopy: v === true })} />
                  <FieldLabel htmlFor="forward-keep" className="font-normal">{t('Keep a copy here')}</FieldLabel>
                </Field>
              </FieldSet>
              {current.data?.otherFiltersActive ? (
                <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{t('Filters set up in a mail app are active. Saving here turns them off.')}</p>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : saved ? (
                <p role="status" className="text-sm text-muted-foreground">{t('Saved.')}</p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={onClose}>{t('Close')}</Button>
                <Button type="submit" disabled={save.isPending}>
                  {save.isPending ? <Spinner /> : null}{t('Save')}</Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
