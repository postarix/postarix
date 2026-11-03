'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Card } from '@postarix/ui/components/card';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { Input } from '@postarix/ui/components/input';
import { FormSelect, FormSelectOption } from '@postarix/ui/components/select';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { cn } from '@postarix/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Download, FileText, RefreshCw, Search } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, Suspense, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { SERVICES, type ServiceStatus, StateDot } from '@/components/system/services';
import { api, errorMessage } from '@/lib/api';
import { t } from '@/lib/i18n';

type Level = 'error' | 'warning' | 'info' | 'debug';
interface LogEntry {
  time: string | null;
  level: Level;
  source: string | null;
  message: string;
}

const LOG_SERVICES = ['api', 'postfix', 'cyrus', 'rspamd', 'unbound', 'clamav', 'crowdsec', 'certs'] as const;
type LogService = (typeof LOG_SERVICES)[number];

const LEVELS: { value: '' | Level; label: string }[] = [
  { value: '', label: t('All levels') },
  { value: 'info', label: t('Info and above') },
  { value: 'warning', label: t('Warnings and errors') },
  { value: 'error', label: t('Errors only') },
];

const LEVEL_STYLE: Record<Level, { label: string; className: string; row: string }> = {
  error: { label: t('Error'), className: 'bg-destructive/15 text-destructive border-destructive/25', row: 'bg-destructive/[0.04]' },
  warning: { label: t('Warning'), className: 'bg-warning/15 text-warning border-warning/25', row: 'bg-warning/[0.04]' },
  info: { label: t('Info'), className: 'bg-ink/10 text-ink border-ink/20', row: '' },
  debug: { label: t('Debug'), className: 'bg-muted text-muted-foreground border-border', row: '' },
};

/** The parts of `text` matching `needle`, marked. */
function highlight(text: string, needle: string): ReactNode {
  if (!needle) return text;
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  const out: ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(n); i !== -1 && out.length < 100; i = lower.indexOf(n, at)) {
    out.push(text.slice(at, i), <mark key={i} className="rounded-sm bg-stamp/60 px-0.5 text-foreground">{text.slice(i, i + n.length)}</mark>);
    at = i + n.length;
  }
  out.push(text.slice(at));
  return out;
}

function timeOf(iso: string | null): { short: string; full: string } {
  if (!iso) return { short: '—', full: '' };
  const d = new Date(iso);
  return { short: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), full: d.toLocaleString() };
}

function LogsView() {
  const router = useRouter();
  const params = useSearchParams();
  const initial = params.get('service');
  const [service, setService] = useState<LogService>(LOG_SERVICES.includes(initial as LogService) ? (initial as LogService) : 'postfix');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [level, setLevel] = useState<'' | Level>('');
  const [limit, setLimit] = useState('500');
  const [live, setLive] = useState(true);
  const [newestFirst, setNewestFirst] = useState(true);

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const timer = setTimeout(() => setApplied(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const status = useQuery({
    queryKey: ['system', 'status'],
    queryFn: () => api.get<{ data: ServiceStatus[] }>('/system/status').then((r) => r.data),
    refetchInterval: 60_000,
  });
  const logs = useQuery({
    queryKey: ['system', 'log-entries', service, applied, level, limit],
    queryFn: () => {
      const q = new URLSearchParams({ limit });
      if (applied) q.set('filter', applied);
      if (level) q.set('level', level);
      return api.get<{ data: LogEntry[] }>(`/system/log-entries/${service}?${q}`).then((r) => r.data);
    },
    refetchInterval: live ? 5_000 : false,
  });

  const entries = useMemo(() => (newestFirst ? [...(logs.data ?? [])].reverse() : (logs.data ?? [])), [logs.data, newestFirst]);
  const counts = useMemo(() => {
    const c = { error: 0, warning: 0 };
    for (const e of logs.data ?? []) if (e.level === 'error' || e.level === 'warning') c[e.level]++;
    return c;
  }, [logs.data]);

  const choose = (next: LogService) => {
    setService(next);
    router.replace(`/system/logs?service=${next}`);
  };

  const download = () => {
    const text = (logs.data ?? []).map((e) => [e.time ?? '', e.level.toUpperCase(), e.source ?? '', e.message].join('\t')).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${service}-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const stateOf = (name: string) => status.data?.find((s) => s.name === name)?.state ?? 'unknown';

  return (
    <>
      <PageHeader
        title={t('Logs')}
        description={t('The latest lines of every service, newest first. Errors and warnings stand out; search across a service’s last 5000 lines.')}
      />
      <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
        <Card className="h-fit gap-0 p-1.5" role="tablist" aria-label={t('Service')} aria-orientation="vertical">
          {LOG_SERVICES.map((name) => {
            const meta = SERVICES[name]!;
            const Icon = meta.icon;
            const active = service === name;
            return (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => choose(name)}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                <Icon className={cn('size-4 shrink-0', active && 'text-ink')} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{meta.label}</span>
                <StateDot state={name === 'api' ? 'ok' : stateOf(name)} className="size-2" />
              </button>
            );
          })}
        </Card>

        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                aria-label={t('Search the log')}
                placeholder={t('Search: an address, a queue ID, an IP…')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <FormSelect aria-label={t('Level')} value={level} onValueChange={(v) => setLevel(v as '' | Level)} className="w-48">
              {LEVELS.map((l) => (
                <FormSelectOption key={l.value} value={l.value}>
                  {l.label}
                </FormSelectOption>
              ))}
            </FormSelect>
            <FormSelect aria-label={t('Lines')} value={limit} onValueChange={setLimit} className="w-32">
              {['200', '500', '1000', '5000'].map((n) => (
                <FormSelectOption key={n} value={n}>
                  {n} {t('lines')}
                </FormSelectOption>
              ))}
            </FormSelect>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox checked={live} onCheckedChange={(v) => setLive(v === true)} />
              {t('Live (every 5 seconds)')}
            </label>
            <Button variant="ghost" size="sm" onClick={() => setNewestFirst((v) => !v)}>
              {newestFirst ? <ArrowDownWideNarrow aria-hidden /> : <ArrowUpNarrowWide aria-hidden />}
              {newestFirst ? t('Newest first') : t('Oldest first')}
            </Button>
            <span className="flex items-center gap-2 text-muted-foreground">
              {counts.error ? <Badge variant="destructive">{counts.error} {t('errors')}</Badge> : null}
              {counts.warning ? <Badge variant="warning">{counts.warning} {t('warnings')}</Badge> : null}
              <span>
                {logs.data?.length ?? 0} {t('lines')}
              </span>
            </span>
            <span className="ml-auto flex gap-1">
              <LoadingButton variant="ghost" size="sm" loading={logs.isFetching && !live} onClick={() => void logs.refetch()}>
                <RefreshCw aria-hidden />
                {t('Refresh')}
              </LoadingButton>
              <Button variant="ghost" size="sm" onClick={download} disabled={!logs.data?.length}>
                <Download aria-hidden />
                {t('Download')}
              </Button>
            </span>
          </div>

          {logs.error ? (
            <Notice>{errorMessage(logs.error)}</Notice>
          ) : logs.isLoading ? (
            <Skeleton className="h-[32rem] w-full rounded-xl" />
          ) : entries.length ? (
            <Card className="gap-0 overflow-hidden py-0">
              <div className="max-h-[calc(100dvh-19rem)] min-h-96 overflow-auto">
                <table className="w-full border-collapse text-xs">
                  <thead className="sticky top-0 z-10 bg-muted/95 text-left text-muted-foreground backdrop-blur">
                    <tr>
                      <th className="w-24 px-3 py-2 font-medium">{t('Time')}</th>
                      <th className="w-24 px-2 py-2 font-medium">{t('Level')}</th>
                      <th className="w-40 px-2 py-2 font-medium">{t('Source')}</th>
                      <th className="px-2 py-2 font-medium">{t('Message')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {entries.map((entry, i) => {
                      const time = timeOf(entry.time);
                      const style = LEVEL_STYLE[entry.level];
                      return (
                        <tr key={`${entry.time}-${i}`} className={cn('align-top transition-colors hover:bg-accent/40', style.row)}>
                          <td className="px-3 py-1.5 font-mono whitespace-nowrap text-muted-foreground tabular-nums" title={time.full}>
                            {time.short}
                          </td>
                          <td className="px-2 py-1.5">
                            <span className={cn('inline-flex rounded border px-1.5 py-px text-[0.68rem] font-semibold', style.className)}>{style.label}</span>
                          </td>
                          <td className="max-w-40 truncate px-2 py-1.5 font-mono text-muted-foreground" title={entry.source ?? ''}>
                            {entry.source ?? ''}
                          </td>
                          <td className="px-2 py-1.5 font-mono leading-relaxed break-all whitespace-pre-wrap">{highlight(entry.message, applied)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : (
            <EmptyState
              icon={FileText}
              title={applied || level ? t('No matching lines') : t('No log lines yet')}
              description={
                applied || level
                  ? t('Nothing in the latest lines matches. Try another search or level.')
                  : t('The service reports its log every 15 seconds once it runs with the reports secret (POSTARIX_SECRET_REPORTS).')
              }
            />
          )}
        </div>
      </div>
    </>
  );
}

export default function LogsPage() {
  return (
    <Suspense>
      <LogsView />
    </Suspense>
  );
}
