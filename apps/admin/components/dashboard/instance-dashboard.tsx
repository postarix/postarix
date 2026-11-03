'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@postarix/ui/components/card';
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from '@postarix/ui/components/chart';
import { Progress } from '@postarix/ui/components/progress';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { cn } from '@postarix/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, AtSign, Building2, Globe, Inbox, type LucideIcon, Mail, Plus, ShieldX } from 'lucide-react';
import { useState } from 'react';
import Link from 'next/link';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { CreateOrganizationDialog } from '@/components/create-organization';
import { Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { ServiceList, type ServiceStatus } from '@/components/system/services';
import { api, errorMessage } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useAllOrganizations } from '@/lib/queries';

interface Overview {
  hostname: string;
  version: string | null;
  uptimeSeconds: number;
  counts: { organizations: number; domains: number; pendingDomains: number; mailboxes: number; aliases: number; users: number; quarantined: number };
  queue: { at: string | null; messages: number; held: number; deferred: number };
  services: { ok: number; down: number; unknown: number };
  disks: { service: string; path: string; usedBytes: number; totalBytes: number }[];
}

export interface Traffic {
  hours: { hour: string; delivered: number; spam: number; rejected: number; greylisted: number; outgoing: number }[];
  totals: { delivered: number; spam: number; rejected: number; greylisted: number; outgoing: number };
}

export const trafficConfig = {
  delivered: { label: t('Delivered'), color: 'var(--success)' },
  outgoing: { label: t('Sent'), color: 'var(--ink)' },
  spam: { label: t('Junk'), color: 'var(--warning)' },
  greylisted: { label: t('Greylisted'), color: 'var(--muted-foreground)' },
  rejected: { label: t('Refused'), color: 'var(--destructive)' },
} satisfies ChartConfig;

function Tile({ icon: Icon, label, value, note, href }: { icon: LucideIcon; label: string; value: number | string; note?: string | undefined; href?: string }) {
  const body = (
    <Card className={cn('h-full gap-0 py-4', href && 'transition-colors hover:border-ink/30')}>
      <CardContent className="flex items-start justify-between gap-3 px-4">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
          {note ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{note}</p> : null}
        </div>
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-ink">
          <Icon className="size-4.5" aria-hidden />
        </span>
      </CardContent>
    </Card>
  );
  return href ? (
    <Link href={href} className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      {body}
    </Link>
  ) : (
    body
  );
}

const hourLabel = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function TrafficChart({ traffic, className }: { traffic: Traffic; className?: string }) {
  return (
    <ChartContainer config={trafficConfig} className={cn('aspect-auto h-64 w-full', className)}>
      <BarChart data={traffic.hours} margin={{ left: -16, right: 4, top: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="hour" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={hourLabel} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={44} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(label) => hourLabel(String(label))} />} />
        <ChartLegend content={<ChartLegendContent />} />
        {(['delivered', 'outgoing', 'spam', 'greylisted', 'rejected'] as const).map((key, i, keys) => (
          <Bar key={key} dataKey={key} stackId="mail" fill={`var(--color-${key})`} radius={i === keys.length - 1 ? [3, 3, 0, 0] : 0} />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** The whole server at a glance, for instance administrators. */
export function InstanceDashboard() {
  const overview = useQuery({ queryKey: ['system', 'overview'], queryFn: () => api.get<Overview>('/system/overview'), refetchInterval: 30_000 });
  const traffic = useQuery({ queryKey: ['system', 'traffic'], queryFn: () => api.get<Traffic>('/system/rspamd/traffic'), refetchInterval: 60_000 });
  const status = useQuery({
    queryKey: ['system', 'status'],
    queryFn: () => api.get<{ data: ServiceStatus[] }>('/system/status').then((r) => r.data),
    refetchInterval: 30_000,
  });
  const orgs = useAllOrganizations(true);
  const o = overview.data;
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title={t('Dashboard')}
        description={o ? `${o.hostname}${o.version ? ` · Postarix ${o.version}` : ''} · ${t('up for {time}', { time: uptime(o.uptimeSeconds) })}` : t('This server at a glance.')}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/system/logs">{t('Open the logs')}</Link>
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('New organization')}
            </Button>
          </>
        }
      />
      {overview.error ? <Notice>{errorMessage(overview.error)}</Notice> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {o ? (
          <>
            <Tile icon={Building2} label={t('Organizations')} value={o.counts.organizations} note={`${o.counts.users} ${t('accounts')}`} href="/organizations" />
            <Tile icon={Globe} label={t('Domains')} value={o.counts.domains} note={o.counts.pendingDomains ? `${o.counts.pendingDomains} ${t('pending verification')}` : t('All verified')} />
            <Tile icon={Inbox} label={t('Mailboxes')} value={o.counts.mailboxes} />
            <Tile icon={AtSign} label={t('Aliases')} value={o.counts.aliases} />
            <Tile icon={ShieldX} label={t('In quarantine')} value={o.counts.quarantined} />
            <Tile
              icon={Mail}
              label={t('Mail queue')}
              value={o.queue.messages}
              note={o.queue.messages ? `${o.queue.deferred} ${t('deferred')}, ${o.queue.held} ${t('held')}` : t('Nothing waiting')}
              href="/system/queue"
            />
          </>
        ) : (
          Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
        )}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>{t('Mail in the last 24 hours')}</CardTitle>
            <CardDescription>
              {traffic.data
                ? `${traffic.data.totals.delivered + traffic.data.totals.spam} ${t('received')}, ${traffic.data.totals.outgoing} ${t('sent')}, ${traffic.data.totals.rejected} ${t('refused')}`
                : t('From the spam filter’s history.')}
            </CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/system/rspamd">
                  {t('History')}
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {traffic.data ? (
              <TrafficChart traffic={traffic.data} />
            ) : traffic.error ? (
              <p className="text-sm text-muted-foreground">{errorMessage(traffic.error)}</p>
            ) : (
              <Skeleton className="h-64 w-full" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('Services')}</CardTitle>
            <CardDescription>
              {o
                ? o.services.down
                  ? `${o.services.down} ${t('not responding')}`
                  : o.services.unknown
                    ? `${o.services.ok} ${t('running')}, ${o.services.unknown} ${t('not reporting yet')}`
                    : t('Everything is running')
                : t('Checking…')}
            </CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/system/services">
                  {t('Details')}
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>{status.data ? <ServiceList services={status.data} compact /> : <Skeleton className="h-48 w-full" />}</CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{t('Storage')}</CardTitle>
            <CardDescription>{t('Disk use as the mail containers report it.')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {o?.disks.length ? (
              o.disks.map((disk) => {
                const pct = disk.totalBytes ? Math.round((disk.usedBytes / disk.totalBytes) * 100) : 0;
                return (
                  <div key={`${disk.service}-${disk.path}`}>
                    <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-medium capitalize">
                        {disk.service} <span className="font-mono text-xs font-normal text-muted-foreground">{disk.path}</span>
                      </span>
                      <span className={cn('tabular-nums', pct >= 90 ? 'text-destructive' : 'text-muted-foreground')}>
                        {formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)}
                      </span>
                    </div>
                    <Progress value={pct} aria-label={`${disk.service}: ${pct}%`} />
                  </div>
                );
              })
            ) : (
              <p className="text-sm text-muted-foreground">{t('No disk report yet.')}</p>
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>{t('Organizations')}</CardTitle>
            <CardDescription>{t('The largest ones first.')}</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/organizations">
                  {t('All organizations')}
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="px-0">
            {orgs.data?.length ? (
              <ul className="divide-y">
                {[...orgs.data]
                  .sort((a, b) => b.counts.mailboxes - a.counts.mailboxes)
                  .slice(0, 6)
                  .map((org) => (
                    <li key={org.id}>
                      <Link href={`/o/${org.id}`} className="flex items-center gap-3 px-6 py-2.5 transition-colors hover:bg-accent/50">
                        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent text-xs font-bold text-ink">
                          {org.name.slice(0, 2).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{org.name}</span>
                        <span className="hidden gap-4 text-xs text-muted-foreground tabular-nums sm:flex">
                          <span>
                            {org.counts.domains} {t('domains')}
                          </span>
                          <span>
                            {org.counts.mailboxes} {t('mailboxes')}
                          </span>
                          <span>
                            {org.counts.members} {t('members')}
                          </span>
                        </span>
                        {org.counts.domains === 0 ? <Badge variant="secondary">{t('No domains')}</Badge> : null}
                      </Link>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="px-6 text-sm text-muted-foreground">{orgs.isLoading ? t('Loading…') : t('No organizations yet')}</p>
            )}
          </CardContent>
        </Card>
      </div>
      <CreateOrganizationDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
