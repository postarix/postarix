'use client';

import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, Select, Spinner, Table, Td, Th } from '@postarix/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2, UserPlus } from 'lucide-react';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { formatDate } from '@/lib/format';
import { keys, useOrganization, useOrgList } from '@/lib/queries';
import type { Member, OrgRole } from '@/lib/types';

const roleTone = { owner: 'accent', admin: 'success', member: 'neutral' } as const;

function useRefresh(orgId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: keys.orgPart(orgId, 'members') });
    void queryClient.invalidateQueries({ queryKey: keys.org(orgId) });
  };
}

function AddMemberDialog({ orgId, canGrantOwner, open, onClose }: { orgId: string; canGrantOwner: boolean; open: boolean; onClose: () => void }) {
  const refresh = useRefresh(orgId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/members`, { email: String(data.get('email')), role: String(data.get('role')) });
      refresh();
      form.reset();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Add member" description="The person needs an account on this instance, for example a mailbox.">
      <form onSubmit={submit} className="space-y-4">
        {error ? <Alert>{error}</Alert> : null}
        <Field label="Email">{(props) => <Input {...props} name="email" type="email" required autoFocus />}</Field>
        <Field label="Role" hint="Admins manage domains, mailboxes and aliases. Owners can also manage other owners.">
          {(props) => (
            <Select {...props} name="role" defaultValue="member">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              {canGrantOwner ? <option value="owner">Owner</option> : null}
            </Select>
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Add member
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RoleSelect({ orgId, member, canGrantOwner }: { orgId: string; member: Member; canGrantOwner: boolean }) {
  const refresh = useRefresh(orgId);
  const [error, setError] = useState<string | null>(null);
  const editable = canGrantOwner || member.role !== 'owner';
  if (!editable) return <Badge tone={roleTone[member.role]}>{member.role}</Badge>;
  return (
    <div>
      <Select
        aria-label={`Role of ${member.email}`}
        className="h-8 w-32"
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
        <option value="member">Member</option>
        <option value="admin">Admin</option>
        {canGrantOwner ? <option value="owner">Owner</option> : null}
      </Select>
      {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
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
        description="People who can manage this organization."
        actions={
          <Button onClick={() => setAdding(true)}>
            <UserPlus className="size-4" aria-hidden />
            Add member
          </Button>
        }
      />
      {members.isLoading ? (
        <Spinner />
      ) : members.error ? (
        <Alert>{errorMessage(members.error)}</Alert>
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Role</Th>
                <Th>Since</Th>
                <Th className="text-right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {members.data?.map((member) => (
                <tr key={member.id}>
                  <Td>
                    <div className="font-medium">
                      {member.name}
                      {member.userId === session?.user.id ? <span className="ml-2 text-xs text-ink-muted">(you)</span> : null}
                    </div>
                    <div className="text-sm text-ink-muted">{member.email}</div>
                  </Td>
                  <Td>
                    <RoleSelect orgId={orgId} member={member} canGrantOwner={canGrantOwner} />
                  </Td>
                  <Td className="text-sm text-ink-muted">{formatDate(member.createdAt)}</Td>
                  <Td>
                    <div className="flex justify-end">
                      {canGrantOwner || member.role !== 'owner' ? (
                        <Button size="sm" variant="ghost" aria-label={`Remove ${member.email}`} onClick={() => setRemoving(member)}>
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
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
