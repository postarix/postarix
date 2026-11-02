'use client';

import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Td, Th } from '@postarix/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm';
import { PasswordInput } from '@/components/password-input';
import { api, errorMessage } from '@/lib/api';
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
    queryFn: () => api.get<{ usedBytes: number | null; quotaBytes: number | null }>(`/orgs/${orgId}/mailboxes/${mailbox.id}/usage`),
    staleTime: 60_000,
    retry: false,
  });
  if (!usage.data || usage.data.usedBytes === null) return <span className="text-ink-muted">{formatBytes(mailbox.quotaBytes)}</span>;
  const { usedBytes, quotaBytes } = usage.data;
  const percent = quotaBytes ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : null;
  return (
    <div className="min-w-32">
      <span className="text-sm">
        {formatBytes(usedBytes)} / {formatBytes(quotaBytes)}
      </span>
      {percent !== null ? (
        <div className="mt-1 h-1.5 rounded-full bg-surface-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Storage used">
          <div className={`h-full rounded-full ${percent >= 90 ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${percent}%` }} />
        </div>
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
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/mailboxes`, {
        domainId: String(data.get('domainId')),
        localPart: String(data.get('localPart')),
        displayName: String(data.get('displayName')),
        password,
        quotaBytes: quotaFromGiB(String(data.get('quota'))),
      });
      refresh();
      form.reset();
      setPassword('');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="New mailbox">
      <form onSubmit={submit} className="space-y-4">
        {error ? <Alert>{error}</Alert> : null}
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
          <Field label="Address">{(props) => <Input {...props} name="localPart" placeholder="jane" required autoFocus />}</Field>
          <span className="pb-2.5 text-ink-muted">@</span>
          <Field label="Domain">
            {(props) => (
              <Select {...props} name="domainId" required>
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Display name">{(props) => <Input {...props} name="displayName" placeholder="Jane Doe" maxLength={128} />}</Field>
        <Field label="Password" hint="At least 12 characters.">
          {(props) => <PasswordInput {...props} value={password} onChange={setPassword} required />}
        </Field>
        <Field label="Quota (GB)" hint="Leave empty for unlimited.">
          {(props) => <Input {...props} name="quota" inputMode="decimal" placeholder="5" />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Create mailbox
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditMailboxDialog({ orgId, mailbox, onClose }: { orgId: string; mailbox: Mailbox; onClose: () => void }) {
  const refresh = useRefresh(orgId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await api.patch(`/orgs/${orgId}/mailboxes/${mailbox.id}`, {
        displayName: String(data.get('displayName')),
        quotaBytes: quotaFromGiB(String(data.get('quota'))),
        status: data.get('enabled') ? 'active' : 'disabled',
      });
      refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={`Edit ${mailbox.address}`}>
      <form onSubmit={submit} className="space-y-4">
        {error ? <Alert>{error}</Alert> : null}
        <Field label="Display name">
          {(props) => <Input {...props} name="displayName" defaultValue={mailbox.displayName} maxLength={128} />}
        </Field>
        <Field label="Quota (GB)" hint="Leave empty for unlimited.">
          {(props) => <Input {...props} name="quota" inputMode="decimal" defaultValue={quotaToGiB(mailbox.quotaBytes)} />}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={mailbox.status === 'active'} className="size-4 accent-[var(--color-accent)]" />
          Enabled (a disabled mailbox cannot sign in and does not receive mail)
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
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
    <Dialog open onClose={onClose} title={`Reset password for ${mailbox.address}`}>
      {done ? (
        <div className="space-y-4">
          <Alert tone="success">Password changed. Share it with the user over a secure channel.</Alert>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error ? <Alert>{error}</Alert> : null}
          <Field label="New password" hint="At least 12 characters.">
            {(props) => <PasswordInput {...props} value={password} onChange={setPassword} required autoFocus />}
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Set password
            </Button>
          </div>
        </form>
      )}
    </Dialog>
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
            <Plus className="size-4" aria-hidden />
            New mailbox
          </Button>
        }
      />
      {domains.data && activeDomains.length === 0 ? (
        <div className="mb-4">
          <Alert tone="warning">
            Verify a domain before creating mailboxes.{' '}
            <Link href={`/o/${orgId}/domains`} className="font-medium underline">
              Go to domains
            </Link>
          </Alert>
        </div>
      ) : null}
      {mailboxes.isLoading ? (
        <Spinner />
      ) : mailboxes.error ? (
        <Alert>{errorMessage(mailboxes.error)}</Alert>
      ) : mailboxes.data?.length ? (
        <Card className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Address</Th>
                <Th>Name</Th>
                <Th>Storage</Th>
                <Th>Status</Th>
                <Th className="text-right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {mailboxes.data.map((mailbox) => (
                <tr key={mailbox.id}>
                  <Td className="font-medium">{mailbox.address}</Td>
                  <Td>{mailbox.displayName || <span className="text-ink-muted">—</span>}</Td>
                  <Td>
                    <Usage orgId={orgId} mailbox={mailbox} />
                  </Td>
                  <Td>{mailbox.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge>Disabled</Badge>}</Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" aria-label={`Edit ${mailbox.address}`} onClick={() => setEditing(mailbox)}>
                        <Pencil className="size-4" aria-hidden />
                      </Button>
                      <Button size="sm" variant="ghost" aria-label={`Reset password for ${mailbox.address}`} onClick={() => setResetting(mailbox)}>
                        <KeyRound className="size-4" aria-hidden />
                      </Button>
                      <Button size="sm" variant="ghost" aria-label={`Delete ${mailbox.address}`} onClick={() => setDeleting(mailbox)}>
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : (
        <EmptyState title="No mailboxes yet" />
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
