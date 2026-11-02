'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { Field, FieldGroup, FieldLabel } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { Progress } from '@postarix/ui/components/progress';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { cn } from '@postarix/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
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
        quotaBytes: quotaFromGiB(String(data.get('quota'))),
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
          <FormField label="Password" hint="At least 12 characters.">
            {(props) => <PasswordInput {...props} value={password} onChange={setPassword} required />}
          </FormField>
          <FormField label="Quota (GB)" hint="Leave empty for unlimited.">
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
          <Field orientation="horizontal">
            <Checkbox id="mailbox-enabled" name="enabled" defaultChecked={mailbox.status === 'active'} />
            <FieldLabel htmlFor="mailbox-enabled" className="font-normal">
              Enabled (a disabled mailbox cannot sign in and does not receive mail)
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
                <TableCell>{mailbox.displayName || <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell>
                  <Usage orgId={orgId} mailbox={mailbox} />
                </TableCell>
                <TableCell>
                  {mailbox.status === 'active' ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Disabled</Badge>}
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

