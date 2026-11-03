'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@postarix/ui/components/card';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { cn } from '@postarix/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, AtSign, Globe, Inbox, type LucideIcon, Plus, ShieldCheck, Users } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DeleteOrganization } from '@/components/delete-organization';
import { PageHeader } from '@/components/page-header';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { formatDate } from '@/lib/format';
import { t } from '@/lib/i18n';
import { isSuperAdmin, keys, useOrganization, useOrgList } from '@/lib/queries';
import type { AuditEvent, Domain, MailLogEntry } from '@/lib/types';

function describe(event: AuditEvent): string {
  const [type, verb] = event.action.split('.');
  const what = (type ?? '').replace(/_/g, ' ');
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} ${(verb ?? '').replace(/_/g, ' ')}`;
}

function Stat({ icon: Icon, label, value, href }: { icon: LucideIcon; label: string; value: number; href?: string | undefined }) {
  const body = (
    <Card className={cn('h-full gap-0 py-4', href && 'transition-colors hover:border-ink/30')}>
      <CardContent className="flex items-center gap-4 px-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent text-ink">
          <Icon className="size-5" aria-hidden />
        </span>
        <span>
          <span className="block text-2xl leading-none font-semibold tabular-nums">{value}</span>
          <span className="mt-1 block text-sm text-muted-foreground">{label}</span>
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

const STATUS: Record<Domain['status'], { label: string; variant: 'success' | 'warning' | 'secondary' }> = {
  active: { label: t('Verified'), variant: 'success' },
  pending: { label: t('Pending verification'), variant: 'warning' },
  disabled: { label: t('Disabled'), variant: 'secondary' },
};

const OUTCOME: Record<MailLogEntry['outcome'], { label: string; variant: 'success' | 'warning' | 'secondary' | 'destructive' }> = {
  delivered: { label: t('Delivered'), variant: 'success' },
  spam: { label: t('Junk'), variant: 'warning' },
  greylisted: { label: t('Greylisted'), variant: 'secondary' },
  deferred: { label: t('Deferred'), variant: 'secondary' },
  rejected: { label: t('Refused'), variant: 'destructive' },
};

function AdminOverview({ orgId }: { orgId: string }) {
  const domains = useOrgList<Domain>(orgId, 'domains');
  const activity = useQuery({
    queryKey: [...keys.orgPart(orgId, 'audit'), 'latest'],
    queryFn: () => api.get<{ data: AuditEvent[] }>(`/orgs/${orgId}/audit?limit=8`).then((r) => r.data),
  });
  const mail = useQuery({
    queryKey: [...keys.orgPart(orgId, 'mail-log'), 'latest'],
    queryFn: () => api.get<{ data: MailLogEntry[] }>(`/orgs/${orgId}/mail-log?limit=8`).then((r) => r.data),
    retry: false,
  });

  return (
    <div className="mt-4 grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t('Domains')}</CardTitle>
          <CardDescription>{t('Their state, and how many mailboxes each has.')}</CardDescription>
          <CardAction>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/o/${orgId}/domains`}>
                {t('Manage')}
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="px-0">
          {domains.isLoading ? (
            <Skeleton className="mx-6 h-24" />
          ) : domains.data?.length ? (
            <ul className="divide-y">
              {domains.data.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-6 py-2.5 text-sm">
                  <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-medium">{d.name}</span>
                  {d.aliasOfDomainId ? <Badge variant="outline">{t('Alias domain')}</Badge> : null}
                  {d.backupMx.enabled ? <Badge variant="outline">{t('Backup MX')}</Badge> : null}
                  <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
                    {d.usage.mailboxes} {t('mailboxes')}
                  </span>
                  <Badge variant={STATUS[d.status].variant}>{STATUS[d.status].label}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-6">
              <p className="text-sm text-muted-foreground">{t('No domains yet. Add one to create mailboxes.')}</p>
              <Button className="mt-3" size="sm" asChild>
                <Link href={`/o/${orgId}/domains`}>
                  <Plus aria-hidden />
                  {t('Add domain')}
                </Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('Latest mail')}</CardTitle>
          <CardDescription>{t('What the spam filter decided for the latest messages.')}</CardDescription>
          <CardAction>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/o/${orgId}/mail-log`}>
                {t('Mail log')}
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="px-0">
          {mail.isLoading ? (
            <Skeleton className="mx-6 h-24" />
          ) : mail.data?.length ? (
            <ul className="divide-y">
              {mail.data.map((m) => (
                <li key={m.id} className="flex items-center gap-3 px-6 py-2 text-sm">
                  <Badge variant={OUTCOME[m.outcome].variant} className="w-20 justify-center">
                    {OUTCOME[m.outcome].label}
                  </Badge>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{m.subject || t('(no subject)')}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {m.direction === 'out' ? `→ ${m.to.join(', ')}` : m.from}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDate(m.time)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-6 text-sm text-muted-foreground">{mail.error ? t('The mail log is not available on this server.') : t('No mail yet.')}</p>
          )}
        </CardContent>
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle>{t('Recent activity')}</CardTitle>
          <CardDescription>{t('The latest changes in this organization.')}</CardDescription>
          <CardAction>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/o/${orgId}/activity`}>
                {t('Activity')}
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="px-0">
          {activity.data?.length ? (
            <ul className="divide-y">
              {activity.data.map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-6 py-2 text-sm">
                  <span className="size-1.5 shrink-0 rounded-full bg-ink" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{describe(e)}</span>
                    {e.targetLabel ? <span className="text-muted-foreground"> · {e.targetLabel}</span> : null}
                  </span>
                  <span className="hidden truncate text-xs text-muted-foreground md:inline">{e.actorEmail ?? ''}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDate(e.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-6 text-sm text-muted-foreground">{activity.isLoading ? t('Loading…') : t('Nothing yet.')}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function OverviewPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const { data: org } = useOrganization(orgId);
  const { data: session } = useSession();
  if (!org) return null;
  const superAdmin = isSuperAdmin(session?.user.role);
  const isAdmin = org.role === 'owner' || org.role === 'admin' || superAdmin;
  const link = (part: string) => (isAdmin ? `/o/${orgId}/${part}` : undefined);

  return (
    <>
      <PageHeader
        title={org.name}
        description={org.role ? `${t('Your role')}: ${org.role}` : t('Instance administrator access')}
        actions={
          isAdmin ? (
            <>
              <Button variant="outline" asChild>
                <Link href={`/o/${orgId}/domains`}>
                  <Globe aria-hidden />
                  {t('Domains')}
                </Link>
              </Button>
              <Button asChild>
                <Link href={`/o/${orgId}/mailboxes`}>
                  <Inbox aria-hidden />
                  {t('Mailboxes')}
                </Link>
              </Button>
            </>
          ) : null
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Globe} label={t('Domains')} value={org.counts.domains} href={link('domains')} />
        <Stat icon={Inbox} label={t('Mailboxes')} value={org.counts.mailboxes} href={link('mailboxes')} />
        <Stat icon={AtSign} label={t('Aliases')} value={org.counts.aliases} href={link('aliases')} />
        <Stat icon={Users} label={t('Members')} value={org.counts.members} href={link('members')} />
      </div>
      {isAdmin ? <AdminOverview orgId={orgId} /> : (
        <Card className="mt-4">
          <CardContent className="flex items-center gap-3 text-sm text-muted-foreground">
            <ShieldCheck className="size-5 text-ink" aria-hidden />
            {t('Only the organization’s administrators manage its domains and mailboxes.')}
          </CardContent>
        </Card>
      )}
      {superAdmin ? <DeleteOrganization org={org} /> : null}
    </>
  );
}
