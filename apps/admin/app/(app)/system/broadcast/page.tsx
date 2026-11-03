'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@postarix/ui/components/card';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { FieldGroup } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { FormSelect, FormSelectOption } from '@postarix/ui/components/select';
import { Textarea } from '@postarix/ui/components/textarea';
import { Users } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm';
import { FormField } from '@/components/form-field';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { api, errorMessage } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useAllOrganizations } from '@/lib/queries';

interface Draft {
  subject: string;
  text: string;
  from: string;
  organizationIds: string[];
  exclude: string[];
}

export default function BroadcastPage() {
  const orgs = useAllOrganizations(true);
  const form = useRef<HTMLFormElement>(null);
  const [scope, setScope] = useState<'all' | 'some'>('all');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ draft: Draft; recipients: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const [pending, setPending] = useState(false);

  const draftOf = (data: FormData): Draft => ({
    subject: String(data.get('subject') ?? '').trim(),
    text: String(data.get('text') ?? '').trim(),
    from: String(data.get('from') ?? '').trim(),
    organizationIds: scope === 'some' ? [...chosen] : [],
    exclude: String(data.get('exclude') ?? '')
      .split(/[\s,]+/)
      .filter(Boolean),
  });

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSent(null);
    if (scope === 'some' && chosen.size === 0) return setError(t('Choose at least one organization.'));
    const draft = draftOf(new FormData(event.currentTarget));
    setPending(true);
    try {
      const { recipients } = await api.post<{ recipients: number }>('/system/broadcast', { ...draft, dryRun: true });
      if (recipients === 0) setError(t('No mailbox would receive it.'));
      else setConfirm({ draft, recipients });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t('Mail to everyone')}
        description={t('A message from the server to every mailbox, or to the mailboxes of some organizations: planned maintenance, a policy change.')}
      />
      <form ref={form} onSubmit={preview} className="grid max-w-5xl gap-4 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardHeader>
            <CardTitle>{t('Message')}</CardTitle>
            <CardDescription>{t('Plain text. Each mailbox gets its own copy.')}</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              {error ? <Notice>{error}</Notice> : null}
              {sent !== null ? (
                <Notice tone="success">{t('Sending to {n} mailboxes. It may take a few minutes.').replace('{n}', String(sent))}</Notice>
              ) : null}
              <FormField label={t('Subject')}>
                {(props) => <Input {...props} name="subject" required maxLength={200} />}
              </FormField>
              <FormField label={t('Text')}>
                {(props) => <Textarea {...props} name="text" required rows={12} maxLength={20000} />}
              </FormField>
              <FormField label={t('Sender')} hint={t('Empty: the server’s system address.')}>
                {(props) => <Input {...props} name="from" type="email" />}
              </FormField>
            </FieldGroup>
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('Recipients')}</CardTitle>
              <CardDescription>{t('Active mailboxes only.')}</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <FormSelect aria-label={t('Recipients')} value={scope} onValueChange={(v) => setScope(v as 'all' | 'some')} className="w-full">
                  <FormSelectOption value="all">{t('Every organization')}</FormSelectOption>
                  <FormSelectOption value="some">{t('Some organizations')}</FormSelectOption>
                </FormSelect>
                {scope === 'some' ? (
                  <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-md border p-2">
                    {orgs.data?.map((o) => (
                      <label key={o.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={chosen.has(o.id)}
                          onCheckedChange={(v) =>
                            setChosen((current) => {
                              const next = new Set(current);
                              if (v === true) next.add(o.id);
                              else next.delete(o.id);
                              return next;
                            })
                          }
                        />
                        <span className="truncate">{o.name}</span>
                      </label>
                    ))}
                  </div>
                ) : null}
                <FormField label={t('Except')} hint={t('Addresses, one per line.')}>
                  {(props) => <Textarea {...props} name="exclude" rows={3} className="font-mono text-xs" />}
                </FormField>
              </FieldGroup>
            </CardContent>
          </Card>
          <LoadingButton type="submit" className="w-full" loading={pending}>
            <Users aria-hidden />
            {t('Review and send')}
          </LoadingButton>
        </div>
      </form>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={t('Send “{subject}”?').replace('{subject}', confirm?.draft.subject ?? '')}
        description={t('{n} mailboxes will receive it. This cannot be undone.').replace('{n}', String(confirm?.recipients ?? 0))}
        confirmLabel={t('Send')}
        onConfirm={async () => {
          if (!confirm) return;
          const { recipients } = await api.post<{ recipients: number }>('/system/broadcast', confirm.draft);
          setSent(recipients);
          form.current?.reset();
          setChosen(new Set());
        }}
      />
    </>
  );
}
