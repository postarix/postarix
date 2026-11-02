'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { FieldGroup } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2, UserPlus } from 'lucide-react';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { AppDialog } from '@/components/app-dialog';
import { ConfirmDialog } from '@/components/confirm';
import { FormField } from '@/components/form-field';
import { ListTable } from '@/components/list-table';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { formatDate } from '@/lib/format';
import { keys, useOrganization, useOrgList } from '@/lib/queries';
import type { Member, OrgRole } from '@/lib/types';

const roleVariant = { owner: 'default', admin: 'secondary', member: 'outline' } as const;

function useRefresh(orgId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: keys.orgPart(orgId, 'members') });
    void queryClient.invalidateQueries({ queryKey: keys.org(orgId) });
  };
}

function RoleOptions({ canGrantOwner }: { canGrantOwner: boolean }) {
  return (
    <>
      <NativeSelectOption value="member">Member</NativeSelectOption>
      <NativeSelectOption value="admin">Admin</NativeSelectOption>
      {canGrantOwner ? <NativeSelectOption value="owner">Owner</NativeSelectOption> : null}
    </>
  );
}

function AddMemberDialog({ orgId, canGrantOwner, open, onClose }: { orgId: string; canGrantOwner: boolean; open: boolean; onClose: () => void }) {
  const refresh = useRefresh(orgId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/members`, { email: String(data.get('email')), role: String(data.get('role')) });
      refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Add member"
      description="The person needs an account on this instance. Mailbox owners are members already."
    >
      <form onSubmit={submit}>
        <FieldGroup>
          {error ? <Notice>{error}</Notice> : null}
          <FormField label="Email">{(props) => <Input {...props} name="email" type="email" required autoFocus />}</FormField>
          <FormField label="Role" hint="Admins manage domains, mailboxes and aliases. Owners can also manage other owners.">
            {(props) => (
              <NativeSelect {...props} name="role" defaultValue="member">
                <RoleOptions canGrantOwner={canGrantOwner} />
              </NativeSelect>
            )}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <LoadingButton type="submit" loading={pending}>
              Add member
            </LoadingButton>
          </DialogFooter>
        </FieldGroup>
      </form>
    </AppDialog>
  );
}

function RoleSelect({ orgId, member, canGrantOwner }: { orgId: string; member: Member; canGrantOwner: boolean }) {
  const refresh = useRefresh(orgId);
  const [error, setError] = useState<string | null>(null);
  if (!canGrantOwner && member.role === 'owner') {
    return <Badge variant={roleVariant[member.role]}>Owner</Badge>;
  }
  return (
    <div className="w-32">
      <NativeSelect
        size="sm"
        aria-label={`Role of ${member.email}`}
        value={member.role}
        onChange={async (event) => {
          setError(null);
          try {
            await api.patch(`/orgs/${orgId}/members/${member.id}`, { role: event.target.value as OrgRole });
            refresh();
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      >
        <RoleOptions canGrantOwner={canGrantOwner} />
      </NativeSelect>
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export default function MembersPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const org = useOrganization(orgId);
  const members = useOrgList<Member>(orgId, 'members');
  const { data: session } = useSession();
  const refresh = useRefresh(orgId);
  const canGrantOwner = org.data?.role === 'owner';
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);

  return (
    <>
      <PageHeader
        title="Members"
        description="People who belong to this organization and what they may manage."
        actions={
          <Button onClick={() => setAdding(true)}>
            <UserPlus aria-hidden />
            Add member
          </Button>
        }
      />
      {members.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : members.error ? (
        <Notice>{errorMessage(members.error)}</Notice>
      ) : (
        <ListTable>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Person</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Since</TableHead>
              <TableHead className="pr-4 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.data?.map((member) => (
              <TableRow key={member.id}>
                <TableCell className="pl-4">
                  <div className="font-medium">
                    {member.name}
                    {member.userId === session?.user.id ? <span className="ml-2 text-xs text-muted-foreground">(you)</span> : null}
                  </div>
                  <div className="text-sm text-muted-foreground">{member.email}</div>
                </TableCell>
                <TableCell>
                  <RoleSelect orgId={orgId} member={member} canGrantOwner={canGrantOwner} />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatDate(member.createdAt)}</TableCell>
                <TableCell className="pr-4">
                  <div className="flex justify-end">
                    {canGrantOwner || member.role !== 'owner' ? (
                      <Button size="icon-sm" variant="ghost" aria-label={`Remove ${member.email}`} onClick={() => setRemoving(member)}>
                        <Trash2 aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ListTable>
      )}
      <AddMemberDialog orgId={orgId} canGrantOwner={canGrantOwner} open={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.email ?? ''}?`}
        description="They lose access to this organization. Their account and mailbox are not affected."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (!removing) return;
          await api.delete(`/orgs/${orgId}/members/${removing.id}`);
          refresh();
        }}
      />
    </>
  );
}
