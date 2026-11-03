'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Card, CardContent } from '@postarix/ui/components/card';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@postarix/ui/components/tabs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm';
import { EmptyState } from '@/components/empty-state';
import { ListTable } from '@/components/list-table';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { formatBytes, formatDate } from '@/lib/format';
import { isSuperAdmin } from '@/lib/queries';
import { RoutingTab } from './routing';

interface ServiceStatus {
  name: string;
  state: 'ok' | 'down' | 'unknown';
  detail: string | null;
  version: string | null;
  checkedAt: string | null;
  disk: { path: string; usedBytes: number; totalBytes: number } | null;
}

interface QueueItem {
  id: string;
  queue: string;
  arrivedAt: string | null;
  sizeBytes: number;
  sender: string;
  recipients: { address: string; reason: string | null }[];
}

const serviceNames: Record<string, string> = {
  api: 'API',
  postgres: 'PostgreSQL',
  valkey: 'Valkey',
  rspamd: 'Rspamd (spam filter)',
  postfix: 'Postfix (SMTP)',
  cyrus: 'Cyrus (IMAP, calendars)',
};

const stateBadge: Record<ServiceStatus['state'], { label: string; variant: 'success' | 'destructive' | 'secondary' }> = {
  ok: { label: 'Running', variant: 'success' },
  down: { label: 'Not responding', variant: 'destructive' },
  unknown: { label: 'Unknown', variant: 'secondary' },
};

function StatusTab() {
  const status = useQuery({
    queryKey: ['system', 'status'],
    queryFn: () => api.get<{ data: ServiceStatus[] }>('/system/status').then((r) => r.data),
    refetchInterval: 30_000,
  });
  if (status.isLoading) return <Skeleton className="h-60 w-full rounded-xl" />;
  if (status.error) return <Notice>{errorMessage(status.error)}</Notice>;
  return (
    <ListTable>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Service</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Version</TableHead>
          <TableHead>Disk</TableHead>
          <TableHead className="pr-4">Details</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {status.data?.map((service) => (
          <TableRow key={service.name}>
            <TableCell className="pl-4 font-medium">{serviceNames[service.name] ?? service.name}</TableCell>
            <TableCell>
              <Badge variant={stateBadge[service.state].variant}>{stateBadge[service.state].label}</Badge>
            </TableCell>
            <TableCell className="text-sm">{service.version ?? '—'}</TableCell>
            <TableCell className="text-sm">
              {service.disk ? `${formatBytes(service.disk.usedBytes)} of ${formatBytes(service.disk.totalBytes)}` : '—'}
            </TableCell>
            <TableCell className="pr-4 text-sm whitespace-normal text-muted-foreground">{service.detail ?? ''}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </ListTable>
  );
}

function LogsTab() {
  const [service, setService] = useState<'postfix' | 'cyrus'>('postfix');
  const [filter, setFilter] = useState('');
  const [applied, setApplied] = useState('');
  const logs = useQuery({
    queryKey: ['system', 'logs', service, applied],
    queryFn: () =>
      api
        .get<{ data: string[] }>(`/system/logs/${service}?limit=500${applied ? `&filter=${encodeURIComponent(applied)}` : ''}`)
        .then((r) => r.data),
    refetchInterval: 15_000,
  });
  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(filter.trim());
        }}
      >
        <NativeSelect aria-label="Service" value={service} onChange={(e) => setService(e.target.value as 'postfix' | 'cyrus')}>
          <NativeSelectOption value="postfix">Postfix (SMTP)</NativeSelectOption>
          <NativeSelectOption value="cyrus">Cyrus (IMAP, POP3, calendars)</NativeSelectOption>
        </NativeSelect>
        <Input
          aria-label="Show only lines containing"
          placeholder="Address, queue ID, IP…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-72"
        />
        <Button type="submit" variant="outline">
          Filter
        </Button>
        <LoadingButton type="button" variant="ghost" loading={logs.isFetching} onClick={() => void logs.refetch()}>
          <RefreshCw aria-hidden />
          Refresh
        </LoadingButton>
      </form>
      {logs.error ? (
        <Notice>{errorMessage(logs.error)}</Notice>
      ) : logs.isLoading ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : logs.data?.length ? (
        <Card className="py-0">
          <CardContent className="p-0">
            <pre className="max-h-[32rem] overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
              {logs.data.join('\n')}
            </pre>
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">
          {applied ? 'No recent line contains this text.' : 'No log lines yet. The mail containers report every 15 seconds.'}
        </p>
      )}
    </div>
  );
}

function QueueTab() {
  const queryClient = useQueryClient();
  const queue = useQuery({
    queryKey: ['system', 'queue'],
    queryFn: () => api.get<{ at: string | null; items: QueueItem[] }>('/system/queue'),
    refetchInterval: 15_000,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<'delete' | 'delete-all' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (body: { action: string; ids?: string[] }) => {
    setError(null);
    try {
      await api.post('/system/queue', body);
      setSelected(new Set());
      setMessage('Sent to Postfix: it applies it within about 15 seconds.');
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['system', 'queue'] }), 16_000);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const items = queue.data?.items ?? [];
  const ids = [...selected];
  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={ids.length === 0} onClick={() => void act({ action: 'deliver', ids })}>
          Deliver now
        </Button>
        <Button variant="outline" disabled={ids.length === 0} onClick={() => void act({ action: 'hold', ids })}>
          Hold
        </Button>
        <Button variant="outline" disabled={ids.length === 0} onClick={() => void act({ action: 'release', ids })}>
          Release
        </Button>
        <Button variant="outline" disabled={ids.length === 0} onClick={() => setConfirming('delete')}>
          Delete
        </Button>
        <span className="mx-1 h-6 w-px bg-border" aria-hidden />
        <Button variant="outline" onClick={() => void act({ action: 'flush' })}>
          Retry all
        </Button>
        <Button variant="outline" disabled={items.length === 0} onClick={() => setConfirming('delete-all')}>
          Delete all
        </Button>
        <LoadingButton variant="ghost" loading={queue.isFetching} onClick={() => void queue.refetch()}>
          <RefreshCw aria-hidden />
          Refresh
        </LoadingButton>
      </div>
      {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      {error ? <Notice>{error}</Notice> : null}
      {queue.error ? (
        <Notice>{errorMessage(queue.error)}</Notice>
      ) : queue.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : items.length ? (
        <ListTable>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10 pl-4">
                <Checkbox
                  aria-label="Select all"
                  checked={selected.size === items.length}
                  onCheckedChange={(v) => setSelected(v === true ? new Set(items.map((i) => i.id)) : new Set())}
                />
              </TableHead>
              <TableHead>Queue ID</TableHead>
              <TableHead>Queue</TableHead>
              <TableHead>Arrived</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Sender</TableHead>
              <TableHead className="pr-4">Recipients and reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="pl-4">
                  <Checkbox aria-label={`Select ${item.id}`} checked={selected.has(item.id)} onCheckedChange={(v) => toggle(item.id, v === true)} />
                </TableCell>
                <TableCell className="font-mono text-xs">{item.id}</TableCell>
                <TableCell>
                  <Badge variant={item.queue === 'hold' ? 'warning' : 'secondary'}>{item.queue}</Badge>
                </TableCell>
                <TableCell className="text-sm">{formatDate(item.arrivedAt)}</TableCell>
                <TableCell className="text-sm">{formatBytes(item.sizeBytes)}</TableCell>
                <TableCell className="text-sm">{item.sender || '(bounce)'}</TableCell>
                <TableCell className="pr-4 text-sm whitespace-normal">
                  <ul className="space-y-1">
                    {item.recipients.map((r) => (
                      <li key={r.address}>
                        {r.address}
                        {r.reason ? <span className="block text-xs text-muted-foreground">{r.reason}</span> : null}
                      </li>
                    ))}
                  </ul>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ListTable>
      ) : (
        <EmptyState
          icon={Inbox}
          title="The mail queue is empty"
          description={queue.data?.at ? `As of ${formatDate(queue.data.at)}.` : 'Postfix has not reported its queue yet.'}
        />
      )}
      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming === 'delete-all' ? 'Delete every queued message?' : `Delete ${ids.length} queued messages?`}
        description="They are not delivered, and their senders are not told."
        onConfirm={async () => {
          if (confirming === 'delete-all') await act({ action: 'delete-all' });
          else await act({ action: 'delete', ids });
        }}
      />
    </div>
  );
}

export default function SystemPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const allowed = isSuperAdmin(session?.user.role);
  useEffect(() => {
    if (session && !allowed) router.replace('/');
  }, [session, allowed, router]);
  if (!allowed) return null;

  return (
    <>
      <PageHeader title="System" description="The state of the services, recent mail logs and the mail queue of this server." />
      <Tabs defaultValue="status">
        <TabsList>
          <TabsTrigger value="status">Services</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="queue">Mail queue</TabsTrigger>
          <TabsTrigger value="routing">Outgoing routing</TabsTrigger>
        </TabsList>
        <TabsContent value="status" className="pt-4">
          <StatusTab />
        </TabsContent>
        <TabsContent value="logs" className="pt-4">
          <LogsTab />
        </TabsContent>
        <TabsContent value="queue" className="pt-4">
          <QueueTab />
        </TabsContent>
        <TabsContent value="routing" className="pt-4">
          <RoutingTab />
        </TabsContent>
      </Tabs>
    </>
  );
}
