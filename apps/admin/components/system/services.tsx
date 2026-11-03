'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Card, CardContent } from '@postarix/ui/components/card';
import { Progress } from '@postarix/ui/components/progress';
import { cn } from '@postarix/ui/lib/utils';
import { Bug, Database, FileText, Globe, Lock, type LucideIcon, Mail, MailOpen, Server, ShieldAlert, ShieldCheck, Zap } from 'lucide-react';
import Link from 'next/link';
import { formatBytes, formatDate } from '@/lib/format';
import { t } from '@/lib/i18n';

export interface ServiceStatus {
  name: string;
  state: 'ok' | 'down' | 'unknown';
  detail: string | null;
  version: string | null;
  checkedAt: string | null;
  disk: { path: string; usedBytes: number; totalBytes: number } | null;
}

/** What each service is, in a few words, and whether its log can be shown. */
export const SERVICES: Record<string, { label: string; role: string; icon: LucideIcon; logs: boolean }> = {
  api: { label: 'API', role: t('Accounts, administration, webmail backend'), icon: Zap, logs: true },
  postgres: { label: 'PostgreSQL', role: t('Database'), icon: Database, logs: false },
  valkey: { label: 'Valkey', role: t('Cache, queues, rate limits'), icon: Database, logs: false },
  rspamd: { label: 'Rspamd', role: t('Spam filter'), icon: ShieldAlert, logs: true },
  postfix: { label: 'Postfix', role: t('Sending and receiving (SMTP)'), icon: Mail, logs: true },
  cyrus: { label: 'Cyrus', role: t('Mail storage, IMAP, POP3, calendars, contacts'), icon: MailOpen, logs: true },
  unbound: { label: 'Unbound', role: t('DNS resolver (DNSSEC)'), icon: Globe, logs: true },
  clamav: { label: 'ClamAV', role: t('Virus scanning'), icon: Bug, logs: true },
  crowdsec: { label: 'CrowdSec', role: t('Blocks attacking addresses'), icon: ShieldCheck, logs: true },
  certs: { label: t('Certificates'), role: t('TLS certificates (ACME)'), icon: Lock, logs: true },
};

const STATE: Record<ServiceStatus['state'], { label: string; dot: string; badge: 'success' | 'destructive' | 'secondary' }> = {
  ok: { label: t('Running'), dot: 'bg-success', badge: 'success' },
  down: { label: t('Not responding'), dot: 'bg-destructive', badge: 'destructive' },
  unknown: { label: t('Unknown'), dot: 'bg-muted-foreground', badge: 'secondary' },
};

export function StateDot({ state, className }: { state: ServiceStatus['state']; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2.5 shrink-0', className)} aria-hidden>
      {state === 'ok' ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-40 motion-reduce:hidden" /> : null}
      <span className={cn('relative inline-flex size-2.5 rounded-full', STATE[state].dot)} />
    </span>
  );
}

/** The services and their state; compact for the dashboard, cards for System → Services. */
export function ServiceList({ services, compact = false }: { services: ServiceStatus[]; compact?: boolean }) {
  if (compact) {
    return (
      <ul className="space-y-2.5">
        {services.map((s) => {
          const meta = SERVICES[s.name];
          return (
            <li key={s.name} className="flex items-center gap-3 text-sm">
              <StateDot state={s.state} />
              <span className="min-w-0 flex-1 truncate font-medium">{meta?.label ?? s.name}</span>
              <span className="truncate text-xs text-muted-foreground">{s.version?.replace(/^Postfix /, '') ?? STATE[s.state].label}</span>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {services.map((s) => {
        const meta = SERVICES[s.name] ?? { label: s.name, role: '', icon: Server, logs: false };
        const Icon = meta.icon;
        const pct = s.disk && s.disk.totalBytes ? Math.round((s.disk.usedBytes / s.disk.totalBytes) * 100) : null;
        return (
          <Card key={s.name} className="gap-4 py-5">
            <CardContent className="space-y-4 px-5">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent text-ink">
                  <Icon className="size-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-semibold">{meta.label}</h3>
                    <Badge variant={STATE[s.state].badge} className="ml-auto gap-1.5">
                      <StateDot state={s.state} className="size-2" />
                      {STATE[s.state].label}
                    </Badge>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">{meta.role}</p>
                </div>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">{t('Version')}</dt>
                <dd className="truncate">{s.version ?? '—'}</dd>
                <dt className="text-muted-foreground">{t('Checked')}</dt>
                <dd className="truncate">{s.checkedAt ? formatDate(s.checkedAt) : '—'}</dd>
                {s.detail ? (
                  <>
                    <dt className="text-muted-foreground">{t('Details')}</dt>
                    <dd className="line-clamp-2 text-muted-foreground">{s.detail}</dd>
                  </>
                ) : null}
              </dl>
              {s.disk && pct !== null ? (
                <div>
                  <div className="mb-1.5 flex justify-between text-xs text-muted-foreground">
                    <span className="font-mono">{s.disk.path}</span>
                    <span className="tabular-nums">
                      {formatBytes(s.disk.usedBytes)} / {formatBytes(s.disk.totalBytes)} ({pct}%)
                    </span>
                  </div>
                  <Progress value={pct} aria-label={`${meta.label}: ${t('disk')} ${pct}%`} />
                </div>
              ) : null}
              {meta.logs ? (
                <Button variant="outline" size="sm" asChild className="w-full">
                  <Link href={`/system/logs?service=${s.name}`}>
                    <FileText aria-hidden />
                    {t('View log')}
                  </Link>
                </Button>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
