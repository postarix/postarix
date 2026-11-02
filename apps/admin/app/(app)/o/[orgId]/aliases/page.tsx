'use client';

import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Td, Th } from '@postarix/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm';
import { api, errorMessage } from '@/lib/api';
import { keys, useOrgList } from '@/lib/queries';
import type { Alias, Domain } from '@/lib/types';

function parseDestinations(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function useRefresh(orgId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: keys.orgPart(orgId, 'aliases') });
    void queryClient.invalidateQueries({ queryKey: keys.org(orgId) });
  };
}

function AliasDialog({
  orgId,
  domains,
  alias,
  onClose,
}: {
  orgId: string;
  domains: Domain[];
  alias: Alias | null;
  onClose: () => void;
}) {
  const refresh = useRefresh(orgId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const destinations = parseDestinations(String(data.get('destinations')));
    const enabled = data.get('enabled') !== null;
    setPending(true);
    setError(null);
    try {
      if (alias) {
        await api.patch(`/orgs/${orgId}/aliases/${alias.id}`, { destinations, enabled });
      } else {
        await api.post(`/orgs/${orgId}/aliases`, {
          domainId: String(data.get('domainId')),
          localPart: String(data.get('localPart')),
          destinations,
          enabled,
        });
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
    <Dialog open onClose={onClose} title={alias ? `Edit ${alias.address}` : 'New alias'} description="Forwards mail to one or more addresses.">
      <form onSubmit={submit} className="space-y-4">
        {error ? <Alert>{error}</Alert> : null}
        {alias ? null : (
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
            <Field label="Address">{(props) => <Input {...props} name="localPart" placeholder="sales" required autoFocus />}</Field>
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
        )}
        <Field label="Deliver to" hint="One address per line (up to 50). External addresses are allowed.">
          {(props) => (
            <textarea
              {...props}
              name="destinations"
              required
              rows={4}
              defaultValue={alias?.destinations.join('\n')}
              className="w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none"
            />
          )}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={alias?.enabled ?? true} className="size-4 accent-[var(--color-accent)]" />
          Enabled
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            {alias ? 'Save' : 'Create alias'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function AliasesPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const aliases = useOrgList<Alias>(orgId, 'aliases');
  const domains = useOrgList<Domain>(orgId, 'domains');
  const refresh = useRefresh(orgId);
  const activeDomains = domains.data?.filter((d) => d.status === 'active') ?? [];
  const [editing, setEditing] = useState<Alias | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Alias | null>(null);

  return (
    <>
      <PageHeader
        title="Aliases"
        description="Addresses that forward mail elsewhere. Mailbox owners can also send as an alias that delivers to them."
        actions={
          <Button onClick={() => setEditing('new')} disabled={activeDomains.length === 0}>
            <Plus className="size-4" aria-hidden />
            New alias
          </Button>
        }
      />
      {aliases.isLoading ? (
        <Spinner />
      ) : aliases.error ? (
        <Alert>{errorMessage(aliases.error)}</Alert>
      ) : aliases.data?.length ? (
        <Card className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Alias</Th>
                <Th>Delivers to</Th>
                <Th>Status</Th>
                <Th className="text-right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {aliases.data.map((alias) => (
                <tr key={alias.id}>
                  <Td className="font-medium">{alias.address}</Td>
                  <Td>
                    <ul className="space-y-0.5 text-sm">
                      {alias.destinations.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  </Td>
                  <Td>{alias.enabled ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}</Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" aria-label={`Edit ${alias.address}`} onClick={() => setEditing(alias)}>
                        <Pencil className="size-4" aria-hidden />
                      </Button>
                      <Button size="sm" variant="ghost" aria-label={`Delete ${alias.address}`} onClick={() => setDeleting(alias)}>
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
        <EmptyState title="No aliases yet" />
      )}
      {editing ? (
        <AliasDialog orgId={orgId} domains={activeDomains} alias={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.address ?? ''}?`}
        description="Mail sent to this address will be rejected."
        onConfirm={async () => {
          if (!deleting) return;
          await api.delete(`/orgs/${orgId}/aliases/${deleting.id}`);
          refresh();
        }}
      />
    </>
  );
}
