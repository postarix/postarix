'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@postarix/ui/components/card';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { FieldGroup } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { Textarea } from '@postarix/ui/components/textarea';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, KeyRound, Plus, RefreshCw, Settings, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
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
import { RateLimitField, rateLimitFrom } from '@/components/rate-limit-field';
import { SpamDialog } from '@/components/spam-dialog';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { formatBytes, formatDate } from '@/lib/format';
import { isSuperAdmin, keys, useOrgList } from '@/lib/queries';
import { quotaFromGiB, quotaToGiB } from '@/lib/quota';
import { useRelayHosts } from '../../../system/routing';
import type { DnsRecord, DnsRecordCheck, Domain } from '@/lib/types';
import { t } from '@/lib/i18n';

const purposeLabel: Record<DnsRecord['purpose'], string> = {
  verification: 'Ownership',
  mx: 'Incoming mail',
  spf: 'SPF',
  dkim: 'DKIM',
  dmarc: 'DMARC',
  autoconfig: 'App setup',
  'mta-sts': 'MTA-STS host',
  'mta-sts-id': 'MTA-STS policy',
};

const statusBadge: Record<DnsRecordCheck['status'], { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  ok: { label: t('Published'), variant: 'success' },
  missing: { label: t('Missing'), variant: 'destructive' },
  mismatch: { label: t('Different'), variant: 'warning' },
  unknown: { label: t('Could not check'), variant: 'secondary' },
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
              <TableHead>{t('Purpose')}</TableHead>
              <TableHead>{t('Status')}</TableHead>
              <TableHead>{t('Type')}</TableHead>
              <TableHead>{t('Name')}</TableHead>
              <TableHead>{t('Value')}</TableHead>
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
                    <p className="mt-1 text-xs break-all text-muted-foreground">{t('Published now:')}{' '}{record.found.join(' · ')}</p>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{t('DNS changes can take a while to appear.')}</span>
        <LoadingButton size="sm" variant="ghost" loading={records.isFetching} onClick={() => void records.refetch()}>
          <RefreshCw aria-hidden />{t('Check again')}</LoadingButton>
      </div>
    </div>
  );
}

/** Converts a count field to a number; empty means no limit. */
function countFrom(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0) throw new Error('Limits must be whole numbers');
  return n;
}

function limitText(used: number, max: number | null, format: (n: number) => string = String): string {
  return max === null ? format(used) : `${format(used)} of ${format(max)}`;
}

function DomainSettingsDialog({
  orgId,
  domain,
  open,
  onClose,
}: {
  orgId: string;
  domain: Domain;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const instanceAdmin = isSuperAdmin(session?.user.role);
  const relayHosts = useRelayHosts(instanceAdmin);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '');
    setPending(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        description: text('description'),
        defaultMailboxQuotaBytes: quotaFromGiB(text('defaultQuota')),
        rateLimit: rateLimitFrom(data),
      };
      if (domain.status !== 'pending') body.enabled = data.get('enabled') === 'on';
      if (instanceAdmin) {
        body.maxMailboxes = countFrom(text('maxMailboxes'));
        body.maxAliases = countFrom(text('maxAliases'));
        body.maxMailboxQuotaBytes = quotaFromGiB(text('maxMailboxQuota'));
        body.totalQuotaBytes = quotaFromGiB(text('totalQuota'));
        if (relayHosts.data) body.relayHostId = text('relayHostId') || null;
      }
      await api.patch(`/orgs/${orgId}/domains/${domain.id}`, body);
      await queryClient.invalidateQueries({ queryKey: keys.orgPart(orgId, 'domains') });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <AppDialog open={open} onClose={onClose} title={`${domain.name} settings`}>
      <form onSubmit={submit}>
        <FieldGroup>
          {error ? <Notice>{error}</Notice> : null}
          <FormField label={t('Description')}>
            {(props) => <Input {...props} name="description" defaultValue={domain.description} maxLength={500} />}
          </FormField>
          <FormField label={t('Default mailbox quota (GB)')} hint={t('Given to new mailboxes when none is chosen. Empty: unlimited.')}>
            {(props) => (
              <Input {...props} name="defaultQuota" inputMode="decimal" defaultValue={quotaToGiB(domain.defaultMailboxQuotaBytes)} />
            )}
          </FormField>
          <RateLimitField
            label={t('Sending limit per mailbox')}
            hint={t('Messages each mailbox may send, unless it has its own limit. Empty: no limit.')}
            value={domain.rateLimit}
          />
          {domain.status !== 'pending' ? (
            <div className="flex items-start gap-2">
              <Checkbox id={`enabled-${domain.id}`} name="enabled" defaultChecked={domain.status === 'active'} />
              <label htmlFor={`enabled-${domain.id}`} className="text-sm">{t('Enabled')}<span className="block text-muted-foreground">{t('A disabled domain receives and sends no mail, and its mailboxes cannot sign in to mail apps.')}</span>
              </label>
            </div>
          ) : null}
          {instanceAdmin ? (
            <>
              <p className="text-sm font-medium">{t('Limits')}</p>
              <p className="-mt-2 text-sm text-muted-foreground">{t('Only instance administrators can change these. Leave a field empty for no limit.')}</p>
              <FormField label={t('Mailboxes')}>
                {(props) => (
                  <Input {...props} name="maxMailboxes" inputMode="numeric" defaultValue={domain.limits.maxMailboxes ?? ''} />
                )}
              </FormField>
              <FormField label={t('Aliases')}>
                {(props) => <Input {...props} name="maxAliases" inputMode="numeric" defaultValue={domain.limits.maxAliases ?? ''} />}
              </FormField>
              <FormField label={t('Largest quota per mailbox (GB)')}>
                {(props) => (
                  <Input
                    {...props}
                    name="maxMailboxQuota"
                    inputMode="decimal"
                    defaultValue={quotaToGiB(domain.limits.maxMailboxQuotaBytes)}
                  />
                )}
              </FormField>
              {relayHosts.data ? (
                <FormField label={t('Send through')} hint={t('A smart host from System → Outgoing routing, for every mailbox without its own.')}>
                  {(props) => (
                    <NativeSelect {...props} name="relayHostId" defaultValue={domain.relayHostId ?? ''} className="w-full">
                      <NativeSelectOption value="">{t('Direct delivery')}</NativeSelectOption>
                      {relayHosts.data.map((r) => (
                        <NativeSelectOption key={r.id} value={r.id}>
                          {r.host}
                          {r.enabled ? '' : ' (disabled)'}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  )}
                </FormField>
              ) : null}
              <FormField label={t('Total quota of all mailboxes (GB)')}>
                {(props) => (
                  <Input {...props} name="totalQuota" inputMode="decimal" defaultValue={quotaToGiB(domain.limits.totalQuotaBytes)} />
                )}
              </FormField>
            </>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t('Cancel')}</Button>
            <LoadingButton type="submit" loading={pending}>{t('Save settings')}</LoadingButton>
          </DialogFooter>
        </FieldGroup>
      </form>
    </AppDialog>
  );
}

interface DkimKey {
  selector: string;
  bits: number | null;
  record: { name: string; value: string };
  createdAt: string;
}

function DkimDialog({ orgId, domain, onClose }: { orgId: string; domain: Domain; onClose: () => void }) {
  const queryClient = useQueryClient();
  const key = useQuery({
    queryKey: [...keys.orgPart(orgId, 'domains'), domain.id, 'dkim'],
    queryFn: () => api.get<{ key: DkimKey | null }>(`/orgs/${orgId}/domains/${domain.id}/dkim`).then((r) => r.key),
  });
  const [mode, setMode] = useState<'generate' | 'import'>('generate');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const selector = String(data.get('selector') ?? '').trim();
    setPending(true);
    setError(null);
    try {
      await api.put(`/orgs/${orgId}/domains/${domain.id}/dkim`, {
        ...(selector ? { selector } : {}),
        ...(mode === 'import' ? { privateKey: String(data.get('privateKey')) } : { keyBits: Number(data.get('keyBits')) }),
      });
      await queryClient.invalidateQueries({ queryKey: keys.orgPart(orgId, 'domains') });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <AppDialog open onClose={onClose} title={`DKIM key of ${domain.name}`} description={t('Outgoing mail is signed with this key.')}>
      <div className="space-y-4">
        {key.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : key.data ? (
          <div className="space-y-1 text-sm">
            <p>{t('Selector')}{' '}<code className="font-mono">{key.data.selector}</code>
              {key.data.bits ? `, ${key.data.bits}-bit RSA` : ''}{t(', since')}{' '}{formatDate(key.data.createdAt)}.
            </p>
            <p className="text-muted-foreground">{t('Publish this TXT record:')}</p>
            <code className="block font-mono text-xs break-all">{key.data.record.name}</code>
            <div className="flex items-start gap-2">
              <code className="block max-h-24 overflow-auto font-mono text-xs break-all">{key.data.record.value}</code>
              <CopyButton value={key.data.record.value} />
            </div>
          </div>
        ) : (
          <Notice>{t('This domain has no signing key: its mail is not DKIM-signed.')}</Notice>
        )}
        <form onSubmit={submit}>
          <FieldGroup>
            <p className="text-sm font-medium">{t('Replace the key')}</p>
            <p className="-mt-2 text-sm text-muted-foreground">{t('The new key signs mail at once. Publish its record before mail goes out, or receivers will fail the signature until it appears in DNS. A new selector lets both records exist side by side.')}</p>
            {error ? <Notice>{error}</Notice> : null}
            <FormField label={t('Selector')} hint={t('Empty: a new one based on today\'s date.')}>
              {(props) => <Input {...props} name="selector" placeholder={t('e.g. mail2026')} maxLength={63} />}
            </FormField>
            <FormField label={t('Key')}>
              {(props) => (
                <NativeSelect {...props} value={mode} onChange={(e) => setMode(e.target.value as 'generate' | 'import')} className="w-full">
                  <NativeSelectOption value="generate">{t('Generate a new key')}</NativeSelectOption>
                  <NativeSelectOption value="import">{t('Import a private key (PEM)')}</NativeSelectOption>
                </NativeSelect>
              )}
            </FormField>
            {mode === 'generate' ? (
              <FormField label={t('Size')} hint={t('2048 bits works everywhere; some DNS providers cannot store larger records.')}>
                {(props) => (
                  <NativeSelect {...props} name="keyBits" defaultValue="2048" className="w-full">
                    <NativeSelectOption value="1024">{t('1024 bits')}</NativeSelectOption>
                    <NativeSelectOption value="2048">{t('2048 bits')}</NativeSelectOption>
                    <NativeSelectOption value="3072">{t('3072 bits')}</NativeSelectOption>
                    <NativeSelectOption value="4096">{t('4096 bits')}</NativeSelectOption>
                  </NativeSelect>
                )}
              </FormField>
            ) : (
              <FormField label={t('Private key')} hint={t('The RSA key the domain already publishes, e.g. from your previous server.')}>
                {(props) => (
                  <Textarea {...props} name="privateKey" rows={6} required className="font-mono text-xs" placeholder={t('-----BEGIN PRIVATE KEY-----')} />
                )}
              </FormField>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>{t('Close')}</Button>
              <LoadingButton type="submit" loading={pending}>{t('Replace key')}</LoadingButton>
            </DialogFooter>
          </FieldGroup>
        </form>
      </div>
    </AppDialog>
  );
}

function DomainCard({ orgId, domain, aliasOf }: { orgId: string; domain: Domain; aliasOf: string | null }) {
  const queryClient = useQueryClient();
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dkim, setDkim] = useState(false);
  const [spam, setSpam] = useState(false);
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
            <Badge variant="success">{t('Verified')}</Badge>
          ) : domain.status === 'pending' ? (
            <Badge variant="warning">{t('Pending verification')}</Badge>
          ) : (
            <Badge variant="secondary">{t('Disabled')}</Badge>
          )}
          {aliasOf ? <Badge variant="outline">{t('Alias of')}{' '}{aliasOf}</Badge> : null}
        </CardTitle>
        <CardDescription>
          {domain.description ? <span className="block">{domain.description}</span> : null}
          {domain.verifiedAt ? `Verified ${formatDate(domain.verifiedAt)}` : `Added ${formatDate(domain.createdAt)}`}
          {' · '}
          {limitText(domain.usage.mailboxes, domain.limits.maxMailboxes)}{' '}{t('mailboxes')}{' · '}
          {limitText(domain.usage.aliases, domain.limits.maxAliases)}{' '}{t('aliases')}{domain.limits.totalQuotaBytes !== null
            ? ` · ${limitText(domain.usage.quotaBytes, domain.limits.totalQuotaBytes, formatBytes)} quota`
            : null}
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
              <ShieldCheck aria-hidden />{t('Verify')}</LoadingButton>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => setShowDns((v) => !v)} aria-expanded={showDns}>
            {showDns ? 'Hide DNS records' : 'DNS records'}
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={`Spam filter of ${domain.name}`} onClick={() => setSpam(true)}>
            <ShieldAlert aria-hidden />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={`DKIM key of ${domain.name}`} onClick={() => setDkim(true)}>
            <KeyRound aria-hidden />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={`${domain.name} settings`} onClick={() => setEditing(true)}>
            <Settings aria-hidden />
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
                <p className="text-sm text-muted-foreground">{t('Publish the ownership record, then press Verify. The other records make mail delivery work and should be published too.')}</p>
              ) : null}
              <DnsRecords orgId={orgId} domain={domain} />
            </>
          ) : null}
        </CardContent>
      ) : null}
      {spam ? (
        <SpamDialog
          title={`Spam filter of ${domain.name}`}
          inherited="the server's"
          scores={domain.spamScores}
          saveScores={async (spamScores) => {
            await api.patch(`/orgs/${orgId}/domains/${domain.id}`, { spamScores });
            refresh();
          }}
          lists={{
            queryKey: [...keys.orgPart(orgId, 'domains'), domain.id, 'spam-lists'],
            listUrl: `/orgs/${orgId}/spam-lists?domainId=${domain.id}`,
            addUrl: `/orgs/${orgId}/spam-lists`,
            deleteUrl: (id) => `/orgs/${orgId}/spam-lists/${id}`,
            extra: { domainId: domain.id },
          }}
          onClose={() => setSpam(false)}
        />
      ) : null}
      {dkim ? <DkimDialog orgId={orgId} domain={domain} onClose={() => setDkim(false)} /> : null}
      {editing ? <DomainSettingsDialog orgId={orgId} domain={domain} open={editing} onClose={() => setEditing(false)} /> : null}
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete ${domain.name}?`}
        description={t('Mailboxes and aliases on this domain must be deleted first. Its DKIM key is destroyed.')}
        onConfirm={async () => {
          await api.delete(`/orgs/${orgId}/domains/${domain.id}`);
          refresh();
        }}
      />
    </Card>
  );
}

function AddDomainDialog({
  orgId,
  domains,
  open,
  onClose,
}: {
  orgId: string;
  domains: Domain[];
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setError(null);
    try {
      const data = new FormData(form);
      const aliasOf = String(data.get('aliasOf') ?? '');
      await api.post(`/orgs/${orgId}/domains`, { name: String(data.get('name')), ...(aliasOf ? { aliasOf } : {}) });
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
    <AppDialog open={open} onClose={onClose} title={t('Add domain')} description={t('You will prove ownership with a DNS record.')}>
      <form onSubmit={submit}>
        <FieldGroup>
          {error ? <Notice>{error}</Notice> : null}
          <FormField label={t('Domain name')}>
            {(props) => <Input {...props} name="name" placeholder="example.com" required autoFocus />}
          </FormField>
          {domains.length > 0 ? (
            <FormField
              label={t('Alias of')}
              hint={t('An alias domain has every address of the chosen domain: mail to ann@alias.example reaches ann@example.com.')}
            >
              {(props) => (
                <NativeSelect {...props} name="aliasOf" defaultValue="" className="w-full">
                  <NativeSelectOption value="">{t('None: a domain of its own')}</NativeSelectOption>
                  {domains.map((d) => (
                    <NativeSelectOption key={d.id} value={d.id}>
                      {d.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </FormField>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t('Cancel')}</Button>
            <LoadingButton type="submit" loading={pending}>{t('Add domain')}</LoadingButton>
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
        title={t('Domains')}
        description={t('Domains this organization receives and sends mail for.')}
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden />{t('Add domain')}</Button>
        }
      />
      {domains.isLoading ? (
        <Skeleton className="h-28 w-full rounded-xl" />
      ) : domains.error ? (
        <Notice>{errorMessage(domains.error)}</Notice>
      ) : domains.data?.length ? (
        <div className="space-y-4">
          {domains.data.map((domain) => (
            <DomainCard
              key={domain.id}
              orgId={orgId}
              domain={domain}
              aliasOf={domains.data?.find((d) => d.id === domain.aliasOfDomainId)?.name ?? null}
            />
          ))}
        </div>
      ) : (
        <EmptyState icon={Globe} title={t('No domains yet')} description={t('Add a domain to start creating mailboxes.')} />
      )}
      <AddDomainDialog
        orgId={orgId}
        domains={domains.data?.filter((d) => !d.aliasOfDomainId) ?? []}
        open={adding}
        onClose={() => setAdding(false)}
      />
    </>
  );
}
