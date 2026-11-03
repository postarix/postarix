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
}: {
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
        delete body.destination;
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
          <Plus aria-hidden />
          Add
        </Button>
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
              <TableHead>Status</TableHead>
              <TableHead className="pr-4 text-right">
                <span className="sr-only">Actions</span>
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
                  {entry.enabled ? <Badge variant="success">Enabled</Badge> : <Badge variant="secondary">Disabled</Badge>}
                </TableCell>
                <TableCell className="pr-4">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Edit"
                      onClick={() => {
                        setError(null);
                        setEditing(entry);
                      }}
                    >
                      <Pencil aria-hidden />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label="Delete" onClick={() => setDeleting(entry)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ListTable>
      ) : (
        <p className="text-sm text-muted-foreground">None.</p>
      )}
      {editing ? (
        <AppDialog open onClose={() => setEditing(null)} title={editing === 'new' ? `Add: ${title}` : `Edit: ${title}`}>
          <form onSubmit={submit}>
            <FieldGroup>
              {error ? <Notice>{error}</Notice> : null}
              {form(editing === 'new' ? null : editing)}
              <Field orientation="horizontal">
                <Checkbox id={`${path}-enabled`} name="enabled" defaultChecked={editing === 'new' ? true : editing.enabled} />
                <FieldLabel htmlFor={`${path}-enabled`} className="font-normal">
                  Enabled
                </FieldLabel>
              </Field>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <LoadingButton type="submit" loading={pending}>
                  Save
                </LoadingButton>
              </DialogFooter>
            </FieldGroup>
          </form>
        </AppDialog>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this entry?"
        description="Postfix stops using it within a few seconds."
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
      <FormField label="Username" hint="Empty: no login.">
        {(props) => <Input {...props} name="username" defaultValue={entry?.username ?? ''} autoComplete="off" />}
      </FormField>
      <FormField label="Password" hint={entry?.hasPassword ? 'Empty: keep the current password.' : undefined}>
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
        title="Smart hosts"
        description="Services (SendGrid, Amazon SES, your provider…) that a domain's or a mailbox's mail can be sent through. Choose one in the domain or mailbox settings."
        columns={['Host', 'Login']}
        row={(r) => [r.host, r.username || '—']}
        form={(r) => (
          <>
            <FormField label="Host" hint="[smtp.example.com]:587 (brackets: no MX lookup).">
              {(props) => <Input {...props} name="host" defaultValue={r?.host ?? ''} required placeholder="[smtp.example.com]:587" />}
            </FormField>
            <Credentials entry={r} />
          </>
        )}
      />
      <EntryList<TransportRoute>
        path="transports"
        title="Routes"
        description="Hand mail for a destination (a domain, .domain for its subdomains, or an address) to a given server instead of its MX."
        columns={['Destination', 'Next hop', 'Login']}
        row={(r) => [r.destination, r.nexthop, r.username || '—']}
        form={(r) => (
          <>
            <FormField label="Destination">
              {(props) => (
                <Input {...props} name="destination" defaultValue={r?.destination ?? ''} required disabled={r !== null} placeholder="partner.example" />
              )}
            </FormField>
            <FormField label="Next hop" hint="[mx.partner.example]:25">
              {(props) => <Input {...props} name="nexthop" defaultValue={r?.nexthop ?? ''} required />}
            </FormField>
            <Credentials entry={r} />
          </>
        )}
      />
      <EntryList<TlsPolicy>
        path="tls-policies"
        title="TLS policies"
        description="How strictly outgoing mail to a destination must be encrypted (by default: DANE where published, otherwise TLS when offered)."
        columns={['Destination', 'Policy', 'Parameters']}
        row={(r) => [r.destination, r.policy, r.parameters || '—']}
        form={(r) => (
          <>
            <FormField label="Destination" hint="A domain, .domain for its subdomains, or [host]:port.">
              {(props) => <Input {...props} name="destination" defaultValue={r?.destination ?? ''} required disabled={r !== null} />}
            </FormField>
            <FormField label="Policy">
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
            <FormField label="Parameters" hint="Optional, e.g. protocols=>=TLSv1.2 match=.example.com">
              {(props) => <Input {...props} name="parameters" defaultValue={r?.parameters ?? ''} />}
            </FormField>
          </>
        )}
      />
    </div>
  );
}
