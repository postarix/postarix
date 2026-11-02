'use client';

import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Spinner, Table, Td, Th } from '@postarix/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm';
import { CopyButton } from '@/components/copy-button';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { keys, useOrgList } from '@/lib/queries';
import type { DnsRecord, Domain } from '@/lib/types';

const purposeLabel: Record<DnsRecord['purpose'], string> = {
  verification: 'Ownership',
  mx: 'Incoming mail',
  spf: 'SPF',
  dkim: 'DKIM',
  dmarc: 'DMARC',
};

function DnsRecords({ orgId, domain }: { orgId: string; domain: Domain }) {
  const records = useQuery({
    queryKey: [...keys.orgPart(orgId, 'domains'), domain.id, 'dns'],
    queryFn: () => api.get<{ data: DnsRecord[] }>(`/orgs/${orgId}/domains/${domain.id}/dns-records`).then((r) => r.data),
  });
  if (records.isLoading) return <Spinner />;
  if (records.error) return <Alert>{errorMessage(records.error)}</Alert>;
  return (
    <div className="overflow-x-auto">
      <Table>
        <thead>
          <tr>
            <Th>Purpose</Th>
            <Th>Type</Th>
            <Th>Name</Th>
            <Th>Value</Th>
          </tr>
        </thead>
        <tbody>
          {records.data?.map((record) => (
            <tr key={`${record.purpose}-${record.name}`}>
              <Td>{purposeLabel[record.purpose]}</Td>
              <Td className="font-mono text-xs">{record.type}</Td>
              <Td className="font-mono text-xs">{record.name}</Td>
              <Td>
                <div className="flex items-start gap-2">
                  <code className="block max-w-md break-all text-xs">{record.value}</code>
                  <CopyButton value={record.value} />
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
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
    <Card className="p-5" data-testid={`domain-${domain.name}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">{domain.name}</h2>
          {domain.status === 'active' ? (
            <Badge tone="success">Verified</Badge>
          ) : domain.status === 'pending' ? (
            <Badge tone="warning">Pending verification</Badge>
          ) : (
            <Badge>Disabled</Badge>
          )}
        </div>
        <div className="flex gap-2">
          {domain.status === 'pending' ? (
            <Button
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
              <ShieldCheck className="size-4" aria-hidden />
              Verify
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" onClick={() => setShowDns((v) => !v)} aria-expanded={showDns}>
            {showDns ? 'Hide DNS records' : 'DNS records'}
          </Button>
          <Button size="sm" variant="ghost" aria-label={`Delete ${domain.name}`} onClick={() => setDeleting(true)}>
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
      <p className="mt-1 text-sm text-ink-muted">
        {domain.verifiedAt ? `Verified ${formatDate(domain.verifiedAt)}` : `Added ${formatDate(domain.createdAt)}`}
      </p>
      {error ? (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}
      {showDns ? (
        <div className="mt-4 space-y-3">
          {domain.status === 'pending' ? (
            <p className="text-sm text-ink-muted">
              Publish the ownership record, then press Verify. The other records make mail delivery work and should be
              published too.
            </p>
          ) : null}
          <DnsRecords orgId={orgId} domain={domain} />
        </div>
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
      form.reset();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Add domain" description="You will prove ownership with a DNS record.">
      <form onSubmit={submit} className="space-y-4">
        {error ? <Alert>{error}</Alert> : null}
        <Field label="Domain name">
          {(props) => <Input {...props} name="name" placeholder="example.com" required autoFocus />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Add domain
          </Button>
        </div>
      </form>
    </Dialog>
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
            <Plus className="size-4" aria-hidden />
            Add domain
          </Button>
        }
      />
      {domains.isLoading ? (
        <Spinner />
      ) : domains.error ? (
        <Alert>{errorMessage(domains.error)}</Alert>
      ) : domains.data?.length ? (
        <div className="space-y-4">
          {domains.data.map((domain) => (
            <DomainCard key={domain.id} orgId={orgId} domain={domain} />
          ))}
        </div>
      ) : (
        <EmptyState title="No domains yet" description="Add a domain to start creating mailboxes." />
      )}
      <AddDomainDialog orgId={orgId} open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
