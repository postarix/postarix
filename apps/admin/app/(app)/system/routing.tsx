'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { Field, FieldGroup, FieldLabel } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { AppDialog } from '@/components/app-dialog';
import { ConfirmDialog } from '@/components/confirm';
import { FormField } from '@/components/form-field';
import { ListTable } from '@/components/list-table';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { api, errorMessage } from '@/lib/api';
import { t } from '@/lib/i18n';

export interface RelayHost {
  id: string;
  host: string;
  username: string;
  hasPassword: boolean;
  enabled: boolean;
}

interface TransportRoute {
  id: string;
  destination: string;
  nexthop: string;
  username: string;
  hasPassword: boolean;
  enabled: boolean;
}

interface RecipientMap {
  id: string;
  address: string;
  destination: string;
  enabled: boolean;
}

interface TlsPolicy {
  id: string;
  destination: string;
  policy: string;
  parameters: string;
  enabled: boolean;
}

const tlsLevels = ['none', 'may', 'encrypt', 'dane', 'dane-only', 'fingerprint', 'verify', 'secure'];

/** The smart hosts, for the domain and mailbox settings of instance administrators. */
export function useRelayHosts(enabled: boolean) {
  return useQuery({
    queryKey: ['system', 'relay-hosts'],
    queryFn: () => api.get<{ data: RelayHost[] }>('/system/relay-hosts').then((r) => r.data),
    enabled,
  });
}

/** A list of one kind of routing entry, with add, edit and delete. */
function EntryList<T extends { id: string; enabled: boolean }>({
  path,
  title,
  description,
  columns,
  row,
  form,
  keyField = 'destination',
}: {
  /** The field that identifies an entry; it cannot be changed. */
  keyField?: string;
  path: string;
  title: string;
  description: string;
  columns: string[];
  row: (entry: T) => ReactNode[];
  form: (entry: T | null) => ReactNode;
}) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['system', path],
    queryFn: () => api.get<{ data: T[] }>(`/system/${path}`).then((r) => r.data),
  });
  const [editing, setEditing] = useState<T | 'new' | null>(null);
  const [deleting, setDeleting] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['system', path] });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {};
    for (const [key, value] of data.entries()) {
      const text = String(value);
      // An empty password field keeps the stored password.
      if (key === 'password' && text === '' && editing !== 'new') continue;
      body[key] = text;
    }
    body.enabled = data.get('enabled') !== null;
    setPending(true);
    setError(null);
    try {
      if (editing === 'new') await api.post(`/system/${path}`, body);
      else if (editing) {
        delete body[keyField];
        await api.patch(`/system/${path}/${editing.id}`, body);
      }
      refresh();
      setEditing(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="font-medium">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setError(null);
            setEditing('new');
          }}
        >
          <Plus aria-hidden />{t('Add')}</Button>
      </div>
      {list.isLoading ? (
        <Skeleton className="h-20 w-full rounded-xl" />
      ) : list.error ? (
        <Notice>{errorMessage(list.error)}</Notice>
      ) : list.data?.length ? (
        <ListTable>
          <TableHeader>
            <TableRow>
              {columns.map((c, i) => (
                <TableHead key={c} className={i === 0 ? 'pl-4' : undefined}>
                  {c}
                </TableHead>
              ))}
              <TableHead>{t('Status')}</TableHead>
              <TableHead className="pr-4 text-right">
                <span className="sr-only">{t('Actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data.map((entry) => (
              <TableRow key={entry.id}>
                {row(entry).map((cell, i) => (
                  <TableCell key={i} className={i === 0 ? 'pl-4 font-medium' : 'text-sm'}>
                    {cell}
                  </TableCell>
                ))}
                <TableCell>
                  {entry.enabled ? <Badge variant="success">{t('Enabled')}</Badge> : <Badge variant="secondary">{t('Disabled')}</Badge>}
                </TableCell>
                <TableCell className="pr-4">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('Edit')}
                      onClick={() => {
                        setError(null);
                        setEditing(entry);
                      }}
                    >
                      <Pencil aria-hidden />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={t('Delete')} onClick={() => setDeleting(entry)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ListTable>
      ) : (
        <p className="text-sm text-muted-foreground">{t('None.')}</p>
      )}
      {editing ? (
        <AppDialog open onClose={() => setEditing(null)} title={editing === 'new' ? `Add: ${title}` : `Edit: ${title}`}>
          <form onSubmit={submit}>
            <FieldGroup>
              {error ? <Notice>{error}</Notice> : null}
              {form(editing === 'new' ? null : editing)}
              <Field orientation="horizontal">
                <Checkbox id={`${path}-enabled`} name="enabled" defaultChecked={editing === 'new' ? true : editing.enabled} />
                <FieldLabel htmlFor={`${path}-enabled`} className="font-normal">{t('Enabled')}</FieldLabel>
              </Field>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>{t('Cancel')}</Button>
                <LoadingButton type="submit" loading={pending}>{t('Save')}</LoadingButton>
              </DialogFooter>
            </FieldGroup>
          </form>
        </AppDialog>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t('Delete this entry?')}
        description={t('Postfix stops using it within a few seconds.')}
        onConfirm={async () => {
          if (!deleting) return;
          await api.delete(`/system/${path}/${deleting.id}`);
          refresh();
        }}
      />
    </section>
  );
}

function Credentials({ entry }: { entry: { username: string; hasPassword: boolean } | null }) {
  return (
    <>
      <FormField label={t('Username')} hint={t('Empty: no login.')}>
        {(props) => <Input {...props} name="username" defaultValue={entry?.username ?? ''} autoComplete="off" />}
      </FormField>
      <FormField label={t('Password')} hint={entry?.hasPassword ? 'Empty: keep the current password.' : undefined}>
        {(props) => <Input {...props} name="password" type="password" autoComplete="new-password" />}
      </FormField>
    </>
  );
}

export function RoutingTab() {
  return (
    <div className="space-y-10">
      <EntryList<RelayHost>
        path="relay-hosts"
        title={t('Smart hosts')}
        description={t('Services (SendGrid, Amazon SES, your provider…) that a domain\'s or a mailbox\'s mail can be sent through. Choose one in the domain or mailbox settings.')}
        columns={['Host', 'Login']}
        row={(r) => [r.host, r.username || '—']}
        form={(r) => (
          <>
            <FormField label={t('Host')} hint={t('[smtp.example.com]:587 (brackets: no MX lookup).')}>
              {(props) => <Input {...props} name="host" defaultValue={r?.host ?? ''} required placeholder={t('[smtp.example.com]:587')} />}
            </FormField>
            <Credentials entry={r} />
          </>
        )}
      />
      <EntryList<TransportRoute>
        path="transports"
        title={t('Routes')}
        description={t('Hand mail for a destination (a domain, .domain for its subdomains, or an address) to a given server instead of its MX.')}
        columns={['Destination', 'Next hop', 'Login']}
        row={(r) => [r.destination, r.nexthop, r.username || '—']}
        form={(r) => (
          <>
            <FormField label={t('Destination')}>
              {(props) => (
                <Input {...props} name="destination" defaultValue={r?.destination ?? ''} required disabled={r !== null} placeholder="partner.example" />
              )}
            </FormField>
            <FormField label={t('Next hop')} hint={t('[mx.partner.example]:25')}>
              {(props) => <Input {...props} name="nexthop" defaultValue={r?.nexthop ?? ''} required />}
            </FormField>
            <Credentials entry={r} />
          </>
        )}
      />
      <EntryList<RecipientMap>
        path="recipient-maps"
        keyField="address"
        title={t('Recipient rewrites')}
        description={t('Deliver mail for an address (here or anywhere else, e.g. a partner\'s old address), or every address of a domain, to another address instead. It wins over mailboxes and aliases.')}
        columns={['Address', 'Delivered to']}
        row={(r) => [r.address, r.destination]}
        form={(r) => (
          <>
            <FormField label={t('Address')} hint={t('An address, or @domain for all of its addresses.')}>
              {(props) => <Input {...props} name="address" defaultValue={r?.address ?? ''} required disabled={r !== null} placeholder="old@partner.example" />}
            </FormField>
            <FormField label={t('Delivered to')}>
              {(props) => <Input {...props} name="destination" type="email" defaultValue={r?.destination ?? ''} required placeholder="new@partner.example" />}
            </FormField>
          </>
        )}
      />
      <EntryList<TlsPolicy>
        path="tls-policies"
        title={t('TLS policies')}
        description={t('How strictly outgoing mail to a destination must be encrypted (by default: DANE where published, otherwise TLS when offered).')}
        columns={['Destination', 'Policy', 'Parameters']}
        row={(r) => [r.destination, r.policy, r.parameters || '—']}
        form={(r) => (
          <>
            <FormField label={t('Destination')} hint={t('A domain, .domain for its subdomains, or [host]:port.')}>
              {(props) => <Input {...props} name="destination" defaultValue={r?.destination ?? ''} required disabled={r !== null} />}
            </FormField>
            <FormField label={t('Policy')}>
              {(props) => (
                <NativeSelect {...props} name="policy" defaultValue={r?.policy ?? 'encrypt'} className="w-full">
                  {tlsLevels.map((level) => (
                    <NativeSelectOption key={level} value={level}>
                      {level}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField label={t('Parameters')} hint={t('Optional, e.g. protocols=>=TLSv1.2 match=.example.com')}>
              {(props) => <Input {...props} name="parameters" defaultValue={r?.parameters ?? ''} />}
            </FormField>
          </>
        )}
      />
    </div>
  );
}
