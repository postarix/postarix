'use client';

import { Button } from '@postarix/ui/components/button';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { FieldGroup } from '@postarix/ui/components/field';
import { FormSelect, FormSelectOption } from '@postarix/ui/components/select';
import { Separator } from '@postarix/ui/components/separator';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Users } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { t } from '@/lib/i18n';
import { keys } from '@/lib/queries';
import type { Mailbox, SharedMember } from '@/lib/types';
import { AppDialog } from './app-dialog';
import { FormField } from './form-field';
import { LoadingButton } from './loading-button';
import { Notice } from './notice';

const RIGHTS: { value: SharedMember['rights']; label: string }[] = [
  { value: 'read', label: t('Read') },
  { value: 'readWrite', label: t('Read and organize') },
  { value: 'send', label: t('Read, organize and send') },
];

/** Who uses a shared mailbox, and what they may do with it. */
export function MembersDialog({ orgId, mailbox, people, onClose }: { orgId: string; mailbox: Mailbox; people: Mailbox[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const queryKey = [...keys.orgPart(orgId, 'mailboxes'), mailbox.id, 'members'];
  const members = useQuery({
    queryKey,
    queryFn: () => api.get<{ data: SharedMember[] }>(`/orgs/${orgId}/mailboxes/${mailbox.id}/members`).then((r) => r.data),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const memberIds = new Set((members.data ?? []).map((m) => m.userId));
  const candidates = people.filter((p) => p.userId && !memberIds.has(p.userId));

  async function act(run: () => Promise<unknown>) {
    setError(null);
    try {
      await run();
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const userId = String(data.get('userId') ?? '');
    if (!userId) return;
    setPending(true);
    await act(() => api.put(`/orgs/${orgId}/mailboxes/${mailbox.id}/members/${encodeURIComponent(userId)}`, { rights: String(data.get('rights')) }));
    setPending(false);
  }

  return (
    <AppDialog
      open
      onClose={onClose}
      title={`${t('Members of')} ${mailbox.address}`}
      description={t(
        'They see this mailbox next to their own, in the webmail and in their mail apps. Taking someone out, or giving them less, applies at once, even to mail apps already connected.',
      )}
    >
      <div className="space-y-5">
        {candidates.length ? (
          <form onSubmit={add}>
            <FieldGroup>
              {error ? <Notice>{error}</Notice> : null}
              <div className="grid grid-cols-[1fr_auto] gap-3">
                <FormField label={t('Person')}>
                  {(props) => (
                    <FormSelect {...props} name="userId" className="w-full">
                      {candidates.map((p) => (
                        <FormSelectOption key={p.userId} value={p.userId!}>
                          {p.displayName ? `${p.displayName} <${p.address}>` : p.address}
                        </FormSelectOption>
                      ))}
                    </FormSelect>
                  )}
                </FormField>
                <FormField label={t('Can')}>
                  {(props) => (
                    <FormSelect {...props} name="rights" defaultValue="readWrite">
                      {RIGHTS.map((r) => (
                        <FormSelectOption key={r.value} value={r.value}>
                          {r.label}
                        </FormSelectOption>
                      ))}
                    </FormSelect>
                  )}
                </FormField>
              </div>
              <DialogFooter>
                <LoadingButton type="submit" loading={pending}>
                  {t('Add member')}
                </LoadingButton>
              </DialogFooter>
            </FieldGroup>
          </form>
        ) : error ? (
          <Notice>{error}</Notice>
        ) : null}
        <Separator />
        {members.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : members.error ? (
          <Notice>{errorMessage(members.error)}</Notice>
        ) : members.data?.length ? (
          <ul className="divide-y rounded-md border">
            {members.data.map((member) => (
              <li key={member.userId} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{member.displayName || member.address}</p>
                  {member.displayName ? <p className="truncate text-xs text-muted-foreground">{member.address}</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <FormSelect
                    aria-label={`${t('Rights of')} ${member.address}`}
                    value={member.rights}
                    onChange={(e) => act(() => api.put(`/orgs/${orgId}/mailboxes/${mailbox.id}/members/${encodeURIComponent(member.userId)}`, { rights: e.target.value }))}
                  >
                    {RIGHTS.map((r) => (
                      <FormSelectOption key={r.value} value={r.value}>
                        {r.label}
                      </FormSelectOption>
                    ))}
                  </FormSelect>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`${t('Remove')}: ${member.address}`}
                    onClick={() => act(() => api.delete(`/orgs/${orgId}/mailboxes/${mailbox.id}/members/${encodeURIComponent(member.userId)}`))}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('No members yet: nobody can use it.')}</p>
        )}
      </div>
    </AppDialog>
  );
}

/** Whether mail sent from the organization's shared mailboxes names who sent it. */
export function SharedSenderOption({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const key = ['org', orgId, 'mail-options'];
  const options = useQuery({ queryKey: key, queryFn: () => api.get<{ sharedSenderHeader: boolean }>(`/orgs/${orgId}/mail-options`) });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function change(sharedSenderHeader: boolean) {
    setPending(true);
    setError(null);
    try {
      queryClient.setQueryData(key, await api.put(`/orgs/${orgId}/mail-options`, { sharedSenderHeader }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="shared-sender-title" className="mb-6 rounded-xl border bg-card p-5">
      <div className="flex items-start gap-3">
        <Users className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h2 id="shared-sender-title" className="text-base font-semibold">{t('Shared mailboxes')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('Who sent each message from a shared mailbox is always kept in Activity. Recipients can also be told, with a Sender header: most mail apps then show “Ana on behalf of Support”.')}
            </p>
          </div>
          {error ? <Notice>{error}</Notice> : null}
          {options.isLoading ? (
            <Skeleton className="h-5 w-64" />
          ) : (
            <div className="flex items-center gap-2">
              <Checkbox
                id="shared-sender-header"
                checked={options.data?.sharedSenderHeader ?? false}
                disabled={pending || !options.data}
                onCheckedChange={(v) => void change(v === true)}
              />
              <label htmlFor="shared-sender-header" className="text-sm">{t('Tell recipients who sent it')}</label>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
