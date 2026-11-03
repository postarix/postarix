'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { Field, FieldGroup, FieldLabel } from '@postarix/ui/components/field';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { Textarea } from '@postarix/ui/components/textarea';
import { useQueryClient } from '@tanstack/react-query';
import { AtSign, Pencil, Plus, Trash2 } from 'lucide-react';
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

function AliasDialog({ orgId, domains, alias, onClose }: { orgId: string; domains: Domain[]; alias: Alias | null; onClose: () => void }) {
  const refresh = useRefresh(orgId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [catchAll, setCatchAll] = useState(false);
  const [discard, setDiscard] = useState(alias?.discard ?? false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const destinations = discard ? [] : parseDestinations(String(data.get('destinations')));
    const enabled = data.get('enabled') !== null;
    setPending(true);
    setError(null);
    try {
      if (alias) {
        await api.patch(`/orgs/${orgId}/aliases/${alias.id}`, { ...(discard ? {} : { destinations }), enabled, discard });
      } else {
        await api.post(`/orgs/${orgId}/aliases`, {
          domainId: String(data.get('domainId')),
          localPart: catchAll ? '' : String(data.get('localPart')),
          destinations,
          enabled,
          discard,
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
    <AppDialog open onClose={onClose} title={alias ? `Edit ${alias.address}` : 'New alias'} description="Forwards mail to one or more addresses.">
      <form onSubmit={submit}>
        <FieldGroup>
          {error ? <Notice>{error}</Notice> : null}
          {alias ? null : (
            <>
              <AddressFields domains={domains} placeholder="sales" anyAddress={catchAll} />
              <Field orientation="horizontal">
                <Checkbox id="alias-catch-all" checked={catchAll} onCheckedChange={(v) => setCatchAll(v === true)} />
                <FieldLabel htmlFor="alias-catch-all" className="font-normal">
                  Catch-all: every address of the domain that is not a mailbox or another alias
                </FieldLabel>
              </Field>
            </>
          )}
          {discard ? null : (
            <FormField label="Deliver to" hint="One address per line (up to 50). External addresses are allowed.">
              {(props) => (
                <Textarea {...props} name="destinations" required rows={4} defaultValue={alias?.destinations.join('\n')} className="font-mono" />
              )}
            </FormField>
          )}
          <Field orientation="horizontal">
            <Checkbox id="alias-discard" checked={discard} onCheckedChange={(v) => setDiscard(v === true)} />
            <FieldLabel htmlFor="alias-discard" className="font-normal">
              Accept mail and silently drop it
            </FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="alias-enabled" name="enabled" defaultChecked={alias?.enabled ?? true} />
            <FieldLabel htmlFor="alias-enabled" className="font-normal">
              Enabled
            </FieldLabel>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <LoadingButton type="submit" loading={pending}>
              {alias ? 'Save' : 'Create alias'}
            </LoadingButton>
          </DialogFooter>
        </FieldGroup>
      </form>
    </AppDialog>
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
        description="Addresses that forward mail elsewhere. A mailbox can also send as an alias of this organization that delivers to it."
        actions={
          <Button onClick={() => setEditing('new')} disabled={activeDomains.length === 0}>
            <Plus aria-hidden />
            New alias
          </Button>
        }
      />
      {aliases.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : aliases.error ? (
        <Notice>{errorMessage(aliases.error)}</Notice>
      ) : aliases.data?.length ? (
        <ListTable>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Alias</TableHead>
              <TableHead>Delivers to</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="pr-4 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {aliases.data.map((alias) => (
              <TableRow key={alias.id}>
                <TableCell className="pl-4 font-medium">
                  {alias.address}
                  {alias.catchAll ? (
                    <Badge variant="secondary" className="ml-2">
                      Catch-all
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>
                  {alias.discard ? (
                    <span className="text-sm text-muted-foreground">Dropped silently</span>
                  ) : (
                    <ul className="space-y-0.5 text-sm">
                      {alias.destinations.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  )}
                </TableCell>
                <TableCell>{alias.enabled ? <Badge variant="success">Enabled</Badge> : <Badge variant="secondary">Disabled</Badge>}</TableCell>
                <TableCell className="pr-4">
                  <div className="flex justify-end gap-1">
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit ${alias.address}`} onClick={() => setEditing(alias)}>
                      <Pencil aria-hidden />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Delete ${alias.address}`} onClick={() => setDeleting(alias)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ListTable>
      ) : (
        <EmptyState icon={AtSign} title="No aliases yet" description="Forward an address such as sales@ to one or more people." />
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
