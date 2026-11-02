'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@postarix/ui/components/card';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { FieldGroup } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { AppDialog } from '@/components/app-dialog';
import { ConfirmDialog } from '@/components/confirm';
import { CopyButton } from '@/components/copy-button';
import { EmptyState } from '@/components/empty-state';
import { FormField } from '@/components/form-field';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { keys, useOrgList } from '@/lib/queries';
import type { DnsRecord, DnsRecordCheck, Domain } from '@/lib/types';

const purposeLabel: Record<DnsRecord['purpose'], string> = {
  verification: 'Ownership',
  mx: 'Incoming mail',
  spf: 'SPF',
  dkim: 'DKIM',
  dmarc: 'DMARC',
};

const statusBadge: Record<DnsRecordCheck['status'], { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  ok: { label: 'Published', variant: 'success' },
  missing: { label: 'Missing', variant: 'destructive' },
  mismatch: { label: 'Different', variant: 'warning' },
  unknown: { label: 'Could not check', variant: 'secondary' },
};

function DnsRecords({ orgId, domain }: { orgId: string; domain: Domain }) {
  const records = useQuery({
    queryKey: [...keys.orgPart(orgId, 'domains'), domain.id, 'dns'],
    queryFn: () => api.get<{ data: DnsRecordCheck[] }>(`/orgs/${orgId}/domains/${domain.id}/dns-check`).then((r) => r.data),
  });
  if (records.isLoading) return <Skeleton className="h-32 w-full" />;
  if (records.error) return <Notice>{errorMessage(records.error)}</Notice>;
  return (
    <div className="space-y-2">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Purpose</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.data?.map((record) => (
              <TableRow key={`${record.purpose}-${record.name}`}>
                <TableCell>{purposeLabel[record.purpose]}</TableCell>
                <TableCell>
                  <Badge variant={statusBadge[record.status].variant}>{statusBadge[record.status].label}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{record.type}</TableCell>
                <TableCell className="font-mono text-xs">{record.name}</TableCell>
                <TableCell className="whitespace-normal">
                  <div className="flex items-start gap-2">
                    <code className="block max-w-md text-xs break-all">{record.value}</code>
                    <CopyButton value={record.value} />
                  </div>
                  {record.found.length > 0 ? (
                    <p className="mt-1 text-xs break-all text-muted-foreground">Published now: {record.found.join(' · ')}</p>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>DNS changes can take a while to appear.</span>
        <LoadingButton size="sm" variant="ghost" loading={records.isFetching} onClick={() => void records.refetch()}>
          <RefreshCw aria-hidden />
          Check again
        </LoadingButton>
      </div>
    </div>
  );
}

function DomainCard({ orgId, domain }: { orgId: string; domain: Domain }) {
  const queryClient = useQueryClient();
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showDns, setShowDns] = useState(domain.status === 'pending');

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.orgPart(orgId, 'domains') });
    void queryClient.invalidateQueries({ queryKey: keys.org(orgId) });
  };

  return (
    <Card data-testid={`domain-${domain.name}`}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
          {domain.name}
          {domain.status === 'active' ? (
            <Badge variant="success">Verified</Badge>
          ) : domain.status === 'pending' ? (
            <Badge variant="warning">Pending verification</Badge>
          ) : (
            <Badge variant="secondary">Disabled</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {domain.verifiedAt ? `Verified ${formatDate(domain.verifiedAt)}` : `Added ${formatDate(domain.createdAt)}`}
        </CardDescription>
        <CardAction className="flex gap-2">
          {domain.status === 'pending' ? (
            <LoadingButton
              size="sm"
              loading={verifying}
              onClick={async () => {
                setVerifying(true);
                setError(null);
                try {
                  await api.post(`/orgs/${orgId}/domains/${domain.id}/verify`);
                  refresh();
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setVerifying(false);
                }
              }}
            >
              <ShieldCheck aria-hidden />
              Verify
            </LoadingButton>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => setShowDns((v) => !v)} aria-expanded={showDns}>
            {showDns ? 'Hide DNS records' : 'DNS records'}
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={`Delete ${domain.name}`} onClick={() => setDeleting(true)}>
            <Trash2 aria-hidden />
          </Button>
        </CardAction>
      </CardHeader>
      {error || showDns ? (
        <CardContent className="space-y-3">
          {error ? <Notice>{error}</Notice> : null}
          {showDns ? (
            <>
              {domain.status === 'pending' ? (
                <p className="text-sm text-muted-foreground">
                  Publish the ownership record, then press Verify. The other records make mail delivery work and should
                  be published too.
                </p>
              ) : null}
              <DnsRecords orgId={orgId} domain={domain} />
            </>
          ) : null}
        </CardContent>
      ) : null}
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete ${domain.name}?`}
        description="Mailboxes and aliases on this domain must be deleted first. Its DKIM key is destroyed."
        onConfirm={async () => {
          await api.delete(`/orgs/${orgId}/domains/${domain.id}`);
          refresh();
        }}
      />
    </Card>
  );
}

function AddDomainDialog({ orgId, open, onClose }: { orgId: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/domains`, { name: String(new FormData(form).get('name')) });
      await queryClient.invalidateQueries({ queryKey: keys.orgPart(orgId, 'domains') });
      await queryClient.invalidateQueries({ queryKey: keys.org(orgId) });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <AppDialog open={open} onClose={onClose} title="Add domain" description="You will prove ownership with a DNS record.">
      <form onSubmit={submit}>
        <FieldGroup>
          {error ? <Notice>{error}</Notice> : null}
          <FormField label="Domain name">
            {(props) => <Input {...props} name="name" placeholder="example.com" required autoFocus />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <LoadingButton type="submit" loading={pending}>
              Add domain
            </LoadingButton>
          </DialogFooter>
        </FieldGroup>
      </form>
    </AppDialog>
  );
}

export default function DomainsPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const domains = useOrgList<Domain>(orgId, 'domains');
  const [adding, setAdding] = useState(false);

  return (
    <>
      <PageHeader
        title="Domains"
        description="Domains this organization receives and sends mail for."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add domain
          </Button>
        }
      />
      {domains.isLoading ? (
        <Skeleton className="h-28 w-full rounded-xl" />
      ) : domains.error ? (
        <Notice>{errorMessage(domains.error)}</Notice>
      ) : domains.data?.length ? (
        <div className="space-y-4">
          {domains.data.map((domain) => (
            <DomainCard key={domain.id} orgId={orgId} domain={domain} />
          ))}
        </div>
      ) : (
        <EmptyState icon={Globe} title="No domains yet" description="Add a domain to start creating mailboxes." />
      )}
      <AddDomainDialog orgId={orgId} open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
