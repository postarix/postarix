'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Input } from '@postarix/ui/components/input';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, RefreshCw, ShieldCheck } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { ListTable } from '@/components/list-table';
import { Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { keys } from '@/lib/queries';
import type { MailLogEntry } from '@/lib/types';
import { t } from '@/lib/i18n';

const OUTCOMES: Record<MailLogEntry['outcome'], { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  delivered: { label: t('Delivered'), variant: 'success' },
  spam: { label: t('Marked as spam'), variant: 'warning' },
  greylisted: { label: t('Greylisted'), variant: 'secondary' },
  deferred: { label: t('Deferred'), variant: 'secondary' },
  rejected: { label: t('Rejected'), variant: 'destructive' },
};

export default function MailLogPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const [filter, setFilter] = useState('');
  const log = useQuery({
    queryKey: keys.orgPart(orgId, 'mail-log'),
    queryFn: () => api.get<{ data: MailLogEntry[] }>(`/orgs/${orgId}/mail-log?limit=500`).then((r) => r.data),
  });
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return log.data ?? [];
    return (log.data ?? []).filter((e) => [e.from, e.subject, ...e.to].some((v) => v.toLowerCase().includes(q)));
  }, [log.data, filter]);

  return (
    <>
      <PageHeader
        title={t('Mail log')}
        description={t('Recent mail to and from your domains, and what the spam filter did with it.')}
        actions={
          <Button variant="outline" onClick={() => void log.refetch()} disabled={log.isFetching}>
            <RefreshCw aria-hidden className={log.isFetching ? 'animate-spin' : undefined} />{t('Refresh')}</Button>
        }
      />
      <div className="mb-4 max-w-sm">
        <Input type="search" placeholder={t('Filter by address or subject')} aria-label={t('Filter the mail log')} value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {log.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : log.error ? (
        <Notice>{errorMessage(log.error)}</Notice>
      ) : rows.length ? (
        <ListTable>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">{t('When')}</TableHead>
              <TableHead>{t('From → To')}</TableHead>
              <TableHead>{t('Subject')}</TableHead>
              <TableHead>{t('Result')}</TableHead>
              <TableHead className="pr-4 text-right">{t('Score')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((entry) => {
              const outcome = OUTCOMES[entry.outcome];
              return (
                <TableRow key={`${entry.id}-${entry.time}`}>
                  <TableCell className="pl-4 align-top whitespace-nowrap text-muted-foreground">{formatDate(entry.time)}</TableCell>
                  <TableCell className="max-w-80 align-top">
                    <div className="flex items-center gap-1.5">
                      {entry.direction === 'in' ? (
                        <ArrowDownLeft className="size-3.5 shrink-0 text-ink" aria-label={t('Incoming')} />
                      ) : (
                        <ArrowUpRight className="size-3.5 shrink-0 text-success" aria-label={t('Outgoing')} />
                      )}
                      <span className="truncate font-medium">{entry.from || '(no sender)'}</span>
                    </div>
                    <div className="truncate pl-5 text-xs text-muted-foreground">{entry.to.join(', ')}</div>
                  </TableCell>
                  <TableCell className="max-w-72 truncate align-top">{entry.subject || <span className="text-muted-foreground">{t('(no subject)')}</span>}</TableCell>
                  <TableCell className="align-top">
                    <Badge variant={outcome.variant}>{outcome.label}</Badge>
                    {entry.reasons.length && entry.outcome !== 'delivered' ? (
                      <div className="mt-1 max-w-64 truncate font-mono text-[0.7rem] text-muted-foreground" title={entry.reasons.map((r) => `${r.name} (${r.score})`).join(', ')}>
                        {entry.reasons.map((r) => r.name).join(' · ')}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="pr-4 text-right align-top tabular-nums">
                    {entry.score}
                    <span className="text-muted-foreground"> / {entry.requiredScore}</span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </ListTable>
      ) : (
        <EmptyState icon={ShieldCheck} title={filter ? 'Nothing matches' : 'No mail yet'} description={filter ? 'Try another address or word.' : 'Messages to and from your domains show up here.'} />
      )}
    </>
  );
}
