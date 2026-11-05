'use client';

import { Button } from '@postarix/ui/components/button';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { FieldGroup } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { Separator } from '@postarix/ui/components/separator';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { t } from '@/lib/i18n';
import { keys } from '@/lib/queries';
import type { ExternalIdentity, Mailbox } from '@/lib/types';
import { AppDialog } from './app-dialog';
import { FormField } from './form-field';
import { LoadingButton } from './loading-button';
import { Notice } from './notice';

/** The identities that stand for a mailbox's owner elsewhere (single sign-on, connected applications). */
export function IdentitiesDialog({ orgId, mailbox, onClose }: { orgId: string; mailbox: Mailbox; onClose: () => void }) {
  const queryClient = useQueryClient();
  const queryKey = [...keys.orgPart(orgId, 'identities'), mailbox.userId];
  const identities = useQuery({
    queryKey,
    queryFn: () => api.get<{ data: ExternalIdentity[] }>(`/orgs/${orgId}/identities?userId=${encodeURIComponent(mailbox.userId ?? '')}`).then((r) => r.data),
    enabled: Boolean(mailbox.userId),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/identities`, {
        mailboxId: mailbox.id,
        issuer: String(data.get('issuer') ?? ''),
        subject: String(data.get('subject') ?? ''),
        label: String(data.get('label') ?? ''),
      });
      form.reset();
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  async function unlink(identity: ExternalIdentity) {
    setError(null);
    try {
      await api.delete(`/orgs/${orgId}/identities/${identity.id}`);
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <AppDialog
      open
      onClose={onClose}
      title={`${t('Identities of')} ${mailbox.address}`}
      description={t(
        'Who this person is for your identity provider or your applications. Single sign-on and connected applications find them by these, whatever email the other side knows them by.',
      )}
    >
      <div className="space-y-5">
        <form onSubmit={submit}>
          <FieldGroup>
            {error ? <Notice>{error}</Notice> : null}
            <FormField label={t('Issuer')} hint={t('The identity provider’s issuer URL, or the name your application uses for itself.')}>
              {(props) => <Input {...props} name="issuer" placeholder="https://login.example.com" required maxLength={500} />}
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField label={t('Subject')} hint={t('Their id there.')}>
                {(props) => <Input {...props} name="subject" className="font-mono" required maxLength={500} />}
              </FormField>
              <FormField label={t('Label')}>{(props) => <Input {...props} name="label" maxLength={200} />}</FormField>
            </div>
            <DialogFooter>
              <LoadingButton type="submit" loading={pending}>
                {t('Link identity')}
              </LoadingButton>
            </DialogFooter>
          </FieldGroup>
        </form>
        <Separator />
        {identities.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : identities.error ? (
          <Notice>{errorMessage(identities.error)}</Notice>
        ) : identities.data?.length ? (
          <ul className="divide-y rounded-md border">
            {identities.data.map((identity) => (
              <li key={identity.id} className="flex items-start justify-between gap-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{identity.label || identity.issuer}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {identity.label ? `${identity.issuer} · ` : ''}
                    <span className="font-mono">{identity.subject}</span>
                  </p>
                </div>
                <Button size="icon-sm" variant="ghost" aria-label={`${t('Unlink')}: ${identity.subject}`} onClick={() => unlink(identity)}>
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('No linked identities.')}</p>
        )}
      </div>
    </AppDialog>
  );
}
