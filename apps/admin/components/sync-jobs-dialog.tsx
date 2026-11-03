'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { FieldGroup } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { FormSelect, FormSelectOption } from '@postarix/ui/components/select';
import { Separator } from '@postarix/ui/components/separator';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Square, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { t } from '@/lib/i18n';
import { keys } from '@/lib/queries';
import type { Mailbox, SyncJob } from '@/lib/types';
import { AppDialog } from './app-dialog';
import { FormField } from './form-field';
import { LoadingButton } from './loading-button';
import { Notice } from './notice';
import { PasswordInput } from './password-input';

const INTERVALS: { minutes: number | null; label: string }[] = [
  { minutes: null, label: t('Once') },
  { minutes: 15, label: t('Every 15 minutes') },
  { minutes: 60, label: t('Every hour') },
  { minutes: 360, label: t('Every 6 hours') },
  { minutes: 1440, label: t('Every day') },
];

function intervalLabel(minutes: number | null): string {
  return INTERVALS.find((i) => i.minutes === minutes)?.label ?? t('Every {n} minutes').replace('{n}', String(minutes));
}

const STATUS: Record<SyncJob['status'], { label: string; variant: 'success' | 'warning' | 'secondary' | 'destructive' }> = {
  queued: { label: t('Queued'), variant: 'secondary' },
  running: { label: t('Running'), variant: 'warning' },
  done: { label: t('Done'), variant: 'success' },
  failed: { label: t('Failed'), variant: 'destructive' },
  cancelled: { label: t('Stopped'), variant: 'secondary' },
};

/** Copies mail from another IMAP server into a mailbox, once or on a schedule (like imapsync). */
export function SyncJobsDialog({ orgId, mailbox, onClose }: { orgId: string; mailbox: Mailbox; onClose: () => void }) {
  const queryClient = useQueryClient();
  const queryKey = [...keys.orgPart(orgId, 'mailboxes'), mailbox.id, 'sync-jobs'];
  const jobs = useQuery({
    queryKey,
    queryFn: () => api.get<{ data: SyncJob[] }>(`/orgs/${orgId}/sync-jobs?mailboxId=${mailbox.id}`).then((r) => r.data),
    refetchInterval: (query) => (query.state.data?.some((j) => j.status === 'queued' || j.status === 'running') ? 3000 : false),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey });
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const port = String(data.get('port') ?? '').trim();
    const interval = String(data.get('interval') ?? '');
    setPending(true);
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/sync-jobs`, {
        mailboxId: mailbox.id,
        host: String(data.get('host') ?? ''),
        ...(port ? { port: Number(port) } : {}),
        security: String(data.get('security') ?? 'tls'),
        username: String(data.get('username') ?? ''),
        password,
        intervalMinutes: interval ? Number(interval) : null,
      });
      form.reset();
      setPassword('');
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  async function act(run: () => Promise<unknown>) {
    setError(null);
    try {
      await run();
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <AppDialog
      open
      onClose={onClose}
      title={`${t('Sync jobs of')} ${mailbox.address}`}
      description={t('Copy mail from another IMAP server into this mailbox. Folders and flags are kept; each run copies only what is new.')}
    >
      <div className="space-y-5">
        <form onSubmit={submit}>
          <FieldGroup>
            {error ? <Notice>{error}</Notice> : null}
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <FormField label={t('IMAP server')}>{(props) => <Input {...props} name="host" placeholder="imap.example.com" required />}</FormField>
              <FormField label={t('Port')}>{(props) => <Input {...props} name="port" inputMode="numeric" placeholder="993" />}</FormField>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField label={t('Security')}>
                {(props) => (
                  <FormSelect {...props} name="security" defaultValue="tls" className="w-full">
                    <FormSelectOption value="tls">TLS</FormSelectOption>
                    <FormSelectOption value="starttls">STARTTLS</FormSelectOption>
                  </FormSelect>
                )}
              </FormField>
              <FormField label={t('Repeat')}>
                {(props) => (
                  <FormSelect {...props} name="interval" defaultValue="" className="w-full">
                    {INTERVALS.map((i) => (
                      <FormSelectOption key={i.label} value={i.minutes ?? ''}>
                        {i.label}
                      </FormSelectOption>
                    ))}
                  </FormSelect>
                )}
              </FormField>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField label={t('User name')}>{(props) => <Input {...props} name="username" autoComplete="off" required />}</FormField>
              <FormField label={t('Password')}>
                {(props) => <PasswordInput {...props} value={password} onChange={setPassword} autoComplete="new-password" required />}
              </FormField>
            </div>
            <DialogFooter>
              <LoadingButton type="submit" loading={pending}>
                {t('Add sync job')}
              </LoadingButton>
            </DialogFooter>
          </FieldGroup>
        </form>
        <Separator />
        {jobs.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : jobs.error ? (
          <Notice>{errorMessage(jobs.error)}</Notice>
        ) : jobs.data?.length ? (
          <ul className="divide-y rounded-md border">
            {jobs.data.map((job) => (
              <li key={job.id} className="flex items-start justify-between gap-2 px-3 py-2 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">
                      {job.username} @ {job.host}
                    </span>
                    <Badge variant={STATUS[job.status].variant}>{STATUS[job.status].label}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {intervalLabel(job.intervalMinutes)}. {t('Copied')}: {job.imported}, {t('skipped')}: {job.skipped}.
                    {job.nextRunAt ? ` ${t('Next run')}: ${formatDate(job.nextRunAt)}.` : ''}
                  </p>
                  {job.error ? <p className="text-xs text-destructive">{job.error}</p> : null}
                </div>
                <div className="flex shrink-0 gap-1">
                  {job.nextRunAt ? (
                    <Button size="icon-sm" variant="ghost" aria-label={`${t('Run now')}: ${job.host}`} onClick={() => act(() => api.post(`/orgs/${orgId}/sync-jobs/${job.id}/run`, {}))}>
                      <Play aria-hidden />
                    </Button>
                  ) : null}
                  {job.status === 'queued' || job.status === 'running' || job.nextRunAt ? (
                    <Button size="icon-sm" variant="ghost" aria-label={`${t('Stop')}: ${job.host}`} onClick={() => act(() => api.post(`/orgs/${orgId}/sync-jobs/${job.id}/cancel`, {}))}>
                      <Square aria-hidden />
                    </Button>
                  ) : null}
                  <Button size="icon-sm" variant="ghost" aria-label={`${t('Delete')}: ${job.host}`} onClick={() => act(() => api.delete(`/orgs/${orgId}/sync-jobs/${job.id}`))}>
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('No sync jobs yet.')}</p>
        )}
      </div>
    </AppDialog>
  );
}
