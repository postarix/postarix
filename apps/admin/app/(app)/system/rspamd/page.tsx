'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@postarix/ui/components/card';
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@postarix/ui/components/chart';
import { Input } from '@postarix/ui/components/input';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { cn } from '@postarix/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ExternalLink, Search, ShieldAlert } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { Cell, Pie, PieChart } from 'recharts';
import { type Traffic, TrafficChart } from '@/components/dashboard/instance-dashboard';
import { EmptyState } from '@/components/empty-state';
import { ListTable } from '@/components/list-table';
import { Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatDate } from '@/lib/format';
import { t } from '@/lib/i18n';

type Outcome = 'delivered' | 'spam' | 'greylisted' | 'deferred' | 'rejected';
interface Scan {
  id: string;
  time: string;
  from: string;
  to: string[];
  subject: string;
  outcome: Outcome;
  action: string;
  score: number;
  requiredScore: number;
  reasons: { name: string; score: number }[];
  ip: string | null;
  user: string | null;
  sizeBytes: number | null;
  scanMs: number | null;
}
interface Stats {
  version: string | null;
  uptimeSeconds: number | null;
  scanned: number;
  learned: number;
  spamCount: number;
  hamCount: number;
  connections: number;
  actions: Record<string, number>;
}

const OUTCOME: Record<Outcome, { label: string; variant: 'success' | 'warning' | 'secondary' | 'destructive' }> = {
  delivered: { label: t('Delivered'), variant: 'success' },
  spam: { label: t('Junk'), variant: 'warning' },
  greylisted: { label: t('Greylisted'), variant: 'secondary' },
  deferred: { label: t('Deferred'), variant: 'secondary' },
  rejected: { label: t('Refused'), variant: 'destructive' },
};

const ACTION_COLORS: Record<string, string> = {
  'no action': 'var(--success)',
  'add header': 'var(--warning)',
  'rewrite subject': 'var(--stamp)',
  greylist: 'var(--muted-foreground)',
  'soft reject': 'var(--ink)',
  reject: 'var(--destructive)',
};
const actionsConfig: ChartConfig = Object.fromEntries(Object.entries(ACTION_COLORS).map(([k, color]) => [k, { label: k, color }]));

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function ScoreBar({ score, required }: { score: number; required: number }) {
  const pct = required > 0 ? Math.max(0, Math.min(100, (score / required) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className={cn('w-12 text-right font-mono text-xs tabular-nums', score >= required && required > 0 ? 'text-destructive' : '')}>{score.toFixed(1)}</span>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className={cn('block h-full rounded-full', pct >= 100 ? 'bg-destructive' : pct >= 40 ? 'bg-warning' : 'bg-success')} style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

export default function RspamdPage() {
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setApplied(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const stats = useQuery({ queryKey: ['system', 'rspamd', 'stats'], queryFn: () => api.get<Stats>('/system/rspamd/stats'), refetchInterval: 30_000 });
  const traffic = useQuery({ queryKey: ['system', 'traffic'], queryFn: () => api.get<Traffic>('/system/rspamd/traffic'), refetchInterval: 60_000 });
  const history = useQuery({
    queryKey: ['system', 'rspamd', 'history', applied],
    queryFn: () =>
      api.get<{ data: Scan[] }>(`/system/rspamd/history?limit=300${applied ? `&filter=${encodeURIComponent(applied)}` : ''}`).then((r) => r.data),
    refetchInterval: 30_000,
  });
  const actions = Object.entries(stats.data?.actions ?? {})
    .filter(([, n]) => n > 0)
    .map(([action, value]) => ({ action, value }));

  return (
    <>
      <PageHeader
        title={t('Spam filter history')}
        description={t('Every message Rspamd checked on this server, what it decided and why.')}
        actions={
          <Button variant="outline" asChild>
            <a href="/api/rspamd-ui/" target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden />
              {t('Rspamd web interface')}
            </a>
          </Button>
        }
      />
      {stats.error ? <Notice>{errorMessage(stats.error)}</Notice> : null}

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>{t('Last 24 hours')}</CardTitle>
            <CardDescription>{t('Messages per hour, by what happened to them.')}</CardDescription>
          </CardHeader>
          <CardContent>{traffic.data ? <TrafficChart traffic={traffic.data} /> : <Skeleton className="h-64 w-full" />}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('Since Rspamd started')}</CardTitle>
            <CardDescription>{stats.data?.version ? `Rspamd ${stats.data.version}` : t('Decisions so far.')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <StatTile label={t('Scanned')} value={stats.data?.scanned ?? '—'} />
              <StatTile label={t('Learned')} value={stats.data?.learned ?? '—'} />
              <StatTile label={t('Learned as spam')} value={stats.data?.spamCount ?? '—'} />
              <StatTile label={t('Learned as ham')} value={stats.data?.hamCount ?? '—'} />
            </div>
            {actions.length ? (
              <div className="flex items-center gap-4">
                <ChartContainer config={actionsConfig} className="aspect-square h-32 shrink-0">
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                    <Pie data={actions} dataKey="value" nameKey="action" innerRadius={34} outerRadius={56} strokeWidth={2}>
                      {actions.map((a) => (
                        <Cell key={a.action} fill={ACTION_COLORS[a.action] ?? 'var(--muted-foreground)'} />
                      ))}
                    </Pie>
                  </PieChart>
                </ChartContainer>
                <ul className="min-w-0 flex-1 space-y-1 text-xs">
                  {actions.map((a) => (
                    <li key={a.action} className="flex items-center gap-2">
                      <span className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: ACTION_COLORS[a.action] ?? 'var(--muted-foreground)' }} />
                      <span className="flex-1 truncate">{a.action}</span>
                      <span className="font-mono tabular-nums">{a.value}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('History')}</h2>
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input aria-label={t('Search the history')} placeholder={t('Sender, recipient, subject, IP…')} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
      </div>
      {history.error ? (
        <Notice>{errorMessage(history.error)}</Notice>
      ) : history.isLoading ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : history.data?.length ? (
        <ListTable>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8 pl-4" />
              <TableHead>{t('Time')}</TableHead>
              <TableHead>{t('Result')}</TableHead>
              <TableHead>{t('Score')}</TableHead>
              <TableHead>{t('From → To')}</TableHead>
              <TableHead className="pr-4">{t('Subject')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.data.map((scan) => {
              const expanded = open === scan.id;
              return (
                <Fragment key={scan.id}>
                  <TableRow className="cursor-pointer" onClick={() => setOpen(expanded ? null : scan.id)} aria-expanded={expanded}>
                    <TableCell className="pl-4">
                      <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', expanded && 'rotate-180')} aria-hidden />
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{formatDate(scan.time)}</TableCell>
                    <TableCell>
                      <Badge variant={OUTCOME[scan.outcome].variant}>{OUTCOME[scan.outcome].label}</Badge>
                      {scan.user ? <Badge variant="outline" className="ml-1">{t('Sent')}</Badge> : null}
                    </TableCell>
                    <TableCell>
                      <ScoreBar score={scan.score} required={scan.requiredScore} />
                    </TableCell>
                    <TableCell className="max-w-72 text-xs">
                      <span className="block truncate">{scan.from || '<>'}</span>
                      <span className="block truncate text-muted-foreground">→ {scan.to.join(', ')}</span>
                    </TableCell>
                    <TableCell className="max-w-80 truncate pr-4 text-sm">{scan.subject || <span className="text-muted-foreground">{t('(no subject)')}</span>}</TableCell>
                  </TableRow>
                  {expanded ? (
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableCell />
                      <TableCell colSpan={5} className="pr-4 whitespace-normal">
                        <dl className="grid gap-x-6 gap-y-1 py-1 text-xs sm:grid-cols-[auto_1fr]">
                          <dt className="text-muted-foreground">{t('Action')}</dt>
                          <dd>
                            {scan.action} ({scan.score} / {scan.requiredScore})
                          </dd>
                          <dt className="text-muted-foreground">{t('Client')}</dt>
                          <dd className="font-mono">{scan.user ? `${scan.user} (${t('signed in')})` : (scan.ip ?? '—')}</dd>
                          {scan.sizeBytes ? (
                            <>
                              <dt className="text-muted-foreground">{t('Size')}</dt>
                              <dd>{formatBytes(scan.sizeBytes)}</dd>
                            </>
                          ) : null}
                          <dt className="text-muted-foreground">{t('Message ID')}</dt>
                          <dd className="font-mono break-all">{scan.id}</dd>
                        </dl>
                        {scan.reasons.length ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {scan.reasons.map((r) => (
                              <span
                                key={r.name}
                                className={cn(
                                  'rounded border px-1.5 py-0.5 font-mono text-[0.7rem]',
                                  r.score > 0 ? 'border-destructive/25 bg-destructive/10 text-destructive' : 'border-success/25 bg-success/10 text-success',
                                )}
                              >
                                {r.name} {r.score > 0 ? '+' : ''}
                                {r.score}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </ListTable>
      ) : (
        <EmptyState icon={ShieldAlert} title={t('Nothing checked yet')} description={t('Messages appear here as Rspamd checks them.')} />
      )}
    </>
  );
}
