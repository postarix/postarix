'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Input } from '@postarix/ui/components/input';
import { FormSelect, FormSelectOption } from '@postarix/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { Copy, RefreshCw, Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { FormField } from '@/components/form-field';
import { LoadingButton } from '@/components/loading-button';
import { PageHeader } from '@/components/page-header';
import { FormDialog, ListCard, useSystemList } from '@/components/system/policy';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { t } from '@/lib/i18n';

interface DkimRow {
  domainId: string;
  domain: string;
  domainStatus: string;
  organizationId: string;
  organization: string;
  selector: string | null;
  bits: number | null;
  createdAt: string | null;
  dns: 'ok' | 'different' | 'missing' | 'unknown';
}

const DNS: Record<DkimRow['dns'], { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  ok: { label: t('Published'), variant: 'success' },
  different: { label: t('Another key in DNS'), variant: 'destructive' },
  missing: { label: t('Not in DNS'), variant: 'warning' },
  unknown: { label: t('Not checked'), variant: 'secondary' },
};

export default function DkimPage() {
  const keys = useSystemList<DkimRow>('dkim');
  const [search, setSearch] = useState('');
  const [copyTo, setCopyTo] = useState<DkimRow | null>(null);
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (keys.data ?? []).filter((r) => !needle || r.domain.includes(needle) || r.organization.toLowerCase().includes(needle));
  }, [keys.data, search]);
  const problems = (keys.data ?? []).filter((r) => r.dns === 'different' || r.dns === 'missing' || !r.selector).length;

  return (
    <>
      <PageHeader
        title={t('DKIM keys')}
        description={t('The signing key of every domain on the server, and whether DNS publishes it. Organizations replace their own keys from each domain’s page.')}
        actions={
          <LoadingButton variant="outline" loading={keys.isFetching} onClick={() => void keys.refetch()}>
            <RefreshCw aria-hidden />
            {t('Check DNS again')}
          </LoadingButton>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input aria-label={t('Search')} placeholder={t('Search a domain or organization')} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        {keys.data ? (
          <span className="text-sm text-muted-foreground">
            {keys.data.length} {t('domains')}
            {problems ? (
              <Badge variant="warning" className="ml-2">
                {problems} {t('need attention')}
              </Badge>
            ) : null}
          </span>
        ) : null}
      </div>
      <ListCard title={t('Domains')} query={{ ...keys, data: keys.data ? rows : undefined }} empty={search ? t('No matching domains') : t('No domains yet')}>
        {(list) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">{t('Domain')}</TableHead>
                <TableHead>{t('Selector')}</TableHead>
                <TableHead>{t('Key')}</TableHead>
                <TableHead>{t('DNS')}</TableHead>
                <TableHead>{t('Created')}</TableHead>
                <TableHead className="pr-6 text-right">
                  <span className="sr-only">{t('Actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => (
                <TableRow key={r.domainId}>
                  <TableCell className="pl-6">
                    <Link href={`/o/${r.organizationId}/domains`} className="block font-medium hover:underline">
                      {r.domain}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {r.organization}
                      {r.domainStatus !== 'active' ? ` · ${t('not verified')}` : ''}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.selector ?? '—'}</TableCell>
                  <TableCell className="text-sm">{r.bits ? `RSA ${r.bits}` : <Badge variant="destructive">{t('No key')}</Badge>}</TableCell>
                  <TableCell>{r.selector ? <Badge variant={DNS[r.dns].variant}>{DNS[r.dns].label}</Badge> : null}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.createdAt ? formatDate(r.createdAt) : '—'}</TableCell>
                  <TableCell className="pr-6 text-right">
                    <Button variant="ghost" size="sm" onClick={() => setCopyTo(r)}>
                      <Copy aria-hidden />
                      {t('Use another domain’s key')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ListCard>
      <FormDialog
        open={copyTo !== null}
        onClose={() => setCopyTo(null)}
        title={t('Sign {domain} with another domain’s key').replace('{domain}', copyTo?.domain ?? '')}
        description={t('Its key is replaced by a copy of the other one (same selector), so both can share one DNS record. Mail is signed with it at once: publish the record first.')}
        submitLabel={t('Use this key')}
        onSubmit={async (data) => {
          await api.post('/system/dkim/duplicate', { fromDomainId: String(data.get('from')), toDomainId: copyTo!.domainId });
          await keys.refresh();
        }}
      >
        <FormField label={t('Key of')}>
          {(props) => (
            <FormSelect {...props} name="from" required className="w-full">
              {(keys.data ?? [])
                .filter((r) => r.selector && r.domainId !== copyTo?.domainId)
                .map((r) => (
                  <FormSelectOption key={r.domainId} value={r.domainId}>
                    {`${r.domain} (${r.selector})`}
                  </FormSelectOption>
                ))}
            </FormSelect>
          )}
        </FormField>
      </FormDialog>
    </>
  );
}
