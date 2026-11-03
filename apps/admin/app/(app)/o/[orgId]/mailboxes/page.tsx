'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { Field, FieldGroup, FieldLabel } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { Progress } from '@postarix/ui/components/progress';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { Textarea } from '@postarix/ui/components/textarea';
import { cn } from '@postarix/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Inbox, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { AddressFields } from '@/components/address-fields';
import { AppDialog } from '@/components/app-dialog';
import { ConfirmDialog } from '@/components/confirm';
import { EmptyState } from '@/components/empty-state';
import { FormField } from '@/components/form-field';
import { ListTable } from '@/components/list-table';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { PasswordInput } from '@/components/password-input';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { keys, useOrgList } from '@/lib/queries';
import { quotaFromGiB, quotaToGiB } from '@/lib/quota';
import type { Domain, Mailbox } from '@/lib/types';

function useRefresh(orgId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: keys.orgPart(orgId, 'mailboxes') });
    void queryClient.invalidateQueries({ queryKey: keys.org(orgId) });
  };
}

function Usage({ orgId, mailbox }: { orgId: string; mailbox: Mailbox }) {
  const usage = useQuery({
    queryKey: [...keys.orgPart(orgId, 'mailboxes'), mailbox.id, 'usage'],
    queryFn: () =>
      api.get<{ usedBytes: number | null; quotaBytes: number | null }>(`/orgs/${orgId}/mailboxes/${mailbox.id}/usage`),
    staleTime: 60_000,
    retry: false,
  });
  if (!usage.data || usage.data.usedBytes === null) {
    return <span className="text-muted-foreground">{formatBytes(mailbox.quotaBytes)}</span>;
  }
  const { usedBytes, quotaBytes } = usage.data;
  const percent = quotaBytes ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : null;
  return (
    <div className="min-w-32 space-y-1">
      <span className="text-sm tabular-nums">
        {formatBytes(usedBytes)} / {formatBytes(quotaBytes)}
      </span>
      {percent !== null ? (
        <Progress
          value={percent}
          aria-label="Storage used"
          className={cn('h-1.5', percent >= 90 && '[&>[data-slot=progress-indicator]]:bg-destructive')}
        />
      ) : null}
    </div>
  );
}

function CreateMailboxDialog({ orgId, domains, open, onClose }: { orgId: string; domains: Domain[]; open: boolean; onClose: () => void }) {
  const refresh = useRefresh(orgId);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/mailboxes`, {
        domainId: String(data.get('domainId')),
        localPart: String(data.get('localPart')),
        displayName: String(data.get('displayName')),
        password,
        // Empty: the domain's default quota.
        ...(String(data.get('quota')).trim() ? { quotaBytes: quotaFromGiB(String(data.get('quota'))) } : {}),
        kind: String(data.get('kind') ?? 'person'),
      });
      refresh();
      setPassword('');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <AppDialog open={open} onClose={onClose} title="New mailbox">
      <form onSubmit={submit}>
        <FieldGroup>
          {error ? <Notice>{error}</Notice> : null}
          <AddressFields domains={domains} placeholder="jane" />
          <FormField label="Display name">{(props) => <Input {...props} name="displayName" placeholder="Jane Doe" maxLength={128} />}</FormField>
          <FormField label="Type" hint="Rooms and equipment are booked by inviting them to an event: they accept when free.">
            {(props) => (
              <NativeSelect {...props} name="kind" defaultValue="person" className="w-full">
                <NativeSelectOption value="person">Person</NativeSelectOption>
                <NativeSelectOption value="room">Room</NativeSelectOption>
                <NativeSelectOption value="equipment">Equipment</NativeSelectOption>
              </NativeSelect>
            )}
          </FormField>
          <FormField label="Password" hint="At least 12 characters.">
            {(props) => <PasswordInput {...props} value={password} onChange={setPassword} required />}
          </FormField>
          <FormField label="Quota (GB)" hint="Leave empty for the domain's default quota.">
            {(props) => <Input {...props} name="quota" inputMode="decimal" placeholder="5" />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <LoadingButton type="submit" loading={pending}>
              Create mailbox
            </LoadingButton>
          </DialogFooter>
        </FieldGroup>
      </form>
    </AppDialog>
  );
}

const protocolOptions: { value: Mailbox['allowedProtocols'][number]; label: string }[] = [
  { value: 'imap', label: 'IMAP' },
  { value: 'pop3', label: 'POP3' },
  { value: 'smtp', label: 'SMTP (sending)' },
  { value: 'sieve', label: 'Sieve filters' },
  { value: 'dav', label: 'Calendars and contacts' },
];

function EditMailboxDialog({ orgId, mailbox, onClose }: { orgId: string; mailbox: Mailbox; onClose: () => void }) {
  const refresh = useRefresh(orgId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const sendAs = useQuery({
    queryKey: [...keys.orgPart(orgId, 'mailboxes'), mailbox.id, 'send-as'],
    queryFn: () => api.get<{ senders: string[] }>(`/orgs/${orgId}/mailboxes/${mailbox.id}/send-as`).then((r) => r.senders),
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await api.patch(`/orgs/${orgId}/mailboxes/${mailbox.id}`, {
        displayName: String(data.get('displayName')),
        quotaBytes: quotaFromGiB(String(data.get('quota'))),
        status: String(data.get('status')),
        allowedProtocols: protocolOptions.map((p) => p.value).filter((p) => data.get(`protocol-${p}`) !== null),
        tlsRequiredIn: data.get('tlsRequiredIn') !== null,
        tlsRequiredOut: data.get('tlsRequiredOut') !== null,
      });
      if (sendAs.data) {
        const senders = String(data.get('sendAs'))
          .split(/[\s,;]+/)
          .map((v) => v.trim())
          .filter(Boolean);
        await api.put(`/orgs/${orgId}/mailboxes/${mailbox.id}/send-as`, { senders });
      }
      refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <AppDialog open onClose={onClose} title={`Edit ${mailbox.address}`}>
      <form onSubmit={submit}>
        <FieldGroup>
          {error ? <Notice>{error}</Notice> : null}
          <FormField label="Display name">
            {(props) => <Input {...props} name="displayName" defaultValue={mailbox.displayName} maxLength={128} />}
          </FormField>
          <FormField label="Quota (GB)" hint="Leave empty for unlimited.">
            {(props) => <Input {...props} name="quota" inputMode="decimal" defaultValue={quotaToGiB(mailbox.quotaBytes)} />}
          </FormField>
          <FormField
            label="Can also send as"
            hint="One per line: an address, or @domain for every address of a domain. Only this organization's domains. Aliases that deliver to the mailbox are allowed already."
          >
            {(props) =>
              sendAs.isLoading ? (
                <Skeleton className="h-20 w-full" />
              ) : (
                <Textarea
                  {...props}
                  name="sendAs"
                  rows={3}
                  className="font-mono"
                  defaultValue={sendAs.data?.join('\n') ?? ''}
                  disabled={!sendAs.data}
                />
              )
            }
          </FormField>
          <FormField label="Status">
            {(props) => (
              <NativeSelect {...props} name="status" defaultValue={mailbox.status} className="w-full">
                <NativeSelectOption value="active">Active</NativeSelectOption>
                <NativeSelectOption value="no_login">Receives mail, nobody can sign in</NativeSelectOption>
                <NativeSelectOption value="disabled">Disabled: no sign-in, no mail</NativeSelectOption>
              </NativeSelect>
            )}
          </FormField>
          <Field>
            <FieldLabel>Mail apps may use</FieldLabel>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {protocolOptions.map((option) => (
                <Field key={option.value} orientation="horizontal" className="w-auto">
                  <Checkbox
                    id={`protocol-${option.value}`}
                    name={`protocol-${option.value}`}
                    defaultChecked={mailbox.allowedProtocols.includes(option.value)}
                  />
                  <FieldLabel htmlFor={`protocol-${option.value}`} className="font-normal">
                    {option.label}
                  </FieldLabel>
                </Field>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">The webmail always works.</p>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="mailbox-tls-in" name="tlsRequiredIn" defaultChecked={mailbox.tlsRequiredIn} />
            <FieldLabel htmlFor="mailbox-tls-in" className="font-normal">
              Refuse incoming mail from servers that do not use TLS
            </FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="mailbox-tls-out" name="tlsRequiredOut" defaultChecked={mailbox.tlsRequiredOut} />
            <FieldLabel htmlFor="mailbox-tls-out" className="font-normal">
              Send outgoing mail only over TLS (otherwise it is returned)
            </FieldLabel>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <LoadingButton type="submit" loading={pending}>
              Save
            </LoadingButton>
          </DialogFooter>
        </FieldGroup>
      </form>
    </AppDialog>
  );
}

function ResetPasswordDialog({ orgId, mailbox, onClose }: { orgId: string; mailbox: Mailbox; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/mailboxes/${mailbox.id}/password`, { password });
      setDone(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <AppDialog open onClose={onClose} title={`Reset password for ${mailbox.address}`}>
      {done ? (
        <FieldGroup>
          <Notice tone="success">Password changed. Share it with the user over a secure channel.</Notice>
          <DialogFooter>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </FieldGroup>
      ) : (
        <form onSubmit={submit}>
          <FieldGroup>
            {error ? <Notice>{error}</Notice> : null}
            <FormField label="New password" hint="At least 12 characters.">
              {(props) => <PasswordInput {...props} value={password} onChange={setPassword} required autoFocus />}
            </FormField>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <LoadingButton type="submit" loading={pending}>
                Set password
              </LoadingButton>
            </DialogFooter>
          </FieldGroup>
        </form>
      )}
    </AppDialog>
  );
}

interface Archiving {
  archiveMailboxId: string | null;
  legalHold: boolean;
}

/**
 * Archiving (a copy of all mail in one mailbox) and legal hold (nothing can
 * be deleted). Owners only: the section stays hidden for other admins.
 */
function ArchivingSection({ orgId, mailboxes }: { orgId: string; mailboxes: Mailbox[] }) {
  const queryClient = useQueryClient();
  const key = ['org', orgId, 'archiving'];
  const archiving = useQuery({
    queryKey: key,
    queryFn: async () => {
      try {
        return await api.get<Archiving>(`/orgs/${orgId}/archiving`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) return null;
        throw e;
      }
    },
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function change(next: Archiving) {
    setPending(true);
    setError(null);
    try {
      queryClient.setQueryData(key, await api.put(`/orgs/${orgId}/archiving`, next));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  if (archiving.data === null) return null;
  const current = archiving.data;
  return (
    <section aria-labelledby="archiving-title" className="mb-6 rounded-xl border bg-card p-5">
      <div className="flex items-start gap-3">
        <Archive className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h2 id="archiving-title" className="text-base font-semibold">
              Archiving and legal hold
            </h2>
            <p className="text-sm text-muted-foreground">
              Keep a copy of every message the organization receives or sends in one mailbox. Under legal hold, no mailbox can be deleted or
              disabled. Keep the archive mailbox&apos;s password with whoever answers for compliance.
            </p>
          </div>
          {error ? <Notice>{error}</Notice> : null}
          {archiving.isLoading || !current ? (
            <Skeleton className="h-5 w-64" />
          ) : (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <label className="flex items-center gap-2 text-sm">
                Archive mailbox
                <NativeSelect
                  value={current.archiveMailboxId ?? ''}
                  disabled={pending}
                  onChange={(e) => void change({ ...current, archiveMailboxId: e.target.value || null })}
                >
                  <NativeSelectOption value="">No archiving</NativeSelectOption>
                  {mailboxes.map((m) => (
                    <NativeSelectOption key={m.id} value={m.id}>
                      {m.address}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="legal-hold"
                  checked={current.legalHold}
                  disabled={pending}
                  onCheckedChange={(v) => void change({ ...current, legalHold: v === true })}
                />
                <label htmlFor="legal-hold" className="text-sm">
                  Legal hold
                </label>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default function MailboxesPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const mailboxes = useOrgList<Mailbox>(orgId, 'mailboxes');
  const domains = useOrgList<Domain>(orgId, 'domains');
  const refresh = useRefresh(orgId);
  const activeDomains = domains.data?.filter((d) => d.status === 'active') ?? [];
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Mailbox | null>(null);
  const [resetting, setResetting] = useState<Mailbox | null>(null);
  const [deleting, setDeleting] = useState<Mailbox | null>(null);

  return (
    <>
      <PageHeader
        title="Mailboxes"
        description="Accounts that sign in and store mail."
        actions={
          <Button onClick={() => setCreating(true)} disabled={activeDomains.length === 0}>
            <Plus aria-hidden />
            New mailbox
          </Button>
        }
      />
      {domains.data && activeDomains.length === 0 ? (
        <div className="mb-4">
          <Notice tone="warning">
            Verify a domain before creating mailboxes.{' '}
            <Link href={`/o/${orgId}/domains`} className="font-medium underline underline-offset-4">
              Go to domains
            </Link>
          </Notice>
        </div>
      ) : null}
      {mailboxes.data?.length ? <ArchivingSection orgId={orgId} mailboxes={mailboxes.data} /> : null}
      {mailboxes.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : mailboxes.error ? (
        <Notice>{errorMessage(mailboxes.error)}</Notice>
      ) : mailboxes.data?.length ? (
        <ListTable>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Address</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Storage</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="pr-4 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {mailboxes.data.map((mailbox) => (
              <TableRow key={mailbox.id}>
                <TableCell className="pl-4 font-medium">{mailbox.address}</TableCell>
                <TableCell>
                  {mailbox.displayName || <span className="text-muted-foreground">—</span>}
                  {mailbox.kind === 'room' ? (
                    <Badge variant="secondary" className="ml-2">
                      Room
                    </Badge>
                  ) : mailbox.kind === 'equipment' ? (
                    <Badge variant="secondary" className="ml-2">
                      Equipment
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Usage orgId={orgId} mailbox={mailbox} />
                </TableCell>
                <TableCell>
                  {mailbox.status === 'active' ? (
                    <Badge variant="success">Active</Badge>
                  ) : mailbox.status === 'no_login' ? (
                    <Badge variant="warning">No sign-in</Badge>
                  ) : (
                    <Badge variant="secondary">Disabled</Badge>
                  )}
                </TableCell>
                <TableCell className="pr-4">
                  <div className="flex justify-end gap-1">
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit ${mailbox.address}`} onClick={() => setEditing(mailbox)}>
                      <Pencil aria-hidden />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Reset password for ${mailbox.address}`}
                      onClick={() => setResetting(mailbox)}
                    >
                      <KeyRound aria-hidden />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Delete ${mailbox.address}`} onClick={() => setDeleting(mailbox)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ListTable>
      ) : (
        <EmptyState icon={Inbox} title="No mailboxes yet" description="Each mailbox is an account with its own storage." />
      )}
      <CreateMailboxDialog orgId={orgId} domains={activeDomains} open={creating} onClose={() => setCreating(false)} />
      {editing ? <EditMailboxDialog orgId={orgId} mailbox={editing} onClose={() => setEditing(null)} /> : null}
      {resetting ? <ResetPasswordDialog orgId={orgId} mailbox={resetting} onClose={() => setResetting(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.address ?? ''}?`}
        description="All mail in this mailbox is permanently deleted. This cannot be undone."
        confirmLabel="Delete mailbox"
        onConfirm={async () => {
          if (!deleting) return;
          await api.delete(`/orgs/${orgId}/mailboxes/${deleting.id}`);
          refresh();
        }}
      />
    </>
  );
}

