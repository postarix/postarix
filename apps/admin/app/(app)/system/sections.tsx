'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm';
import { EmptyState } from '@/components/empty-state';
import { ListTable } from '@/components/list-table';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatDate } from '@/lib/format';
import { t } from '@/lib/i18n';

interface QueueItem {
  id: string;
  queue: string;
  arrivedAt: string | null;
  sizeBytes: number;
  sender: string;
  recipients: { address: string; reason: string | null }[];
}

export function QueueTab() {
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
        <Button variant="outline" disabled={ids.length === 0} onClick={() => void act({ action: 'deliver', ids })}>{t('Deliver now')}</Button>
        <Button variant="outline" disabled={ids.length === 0} onClick={() => void act({ action: 'hold', ids })}>{t('Hold')}</Button>
        <Button variant="outline" disabled={ids.length === 0} onClick={() => void act({ action: 'release', ids })}>{t('Release')}</Button>
        <Button variant="outline" disabled={ids.length === 0} onClick={() => setConfirming('delete')}>{t('Delete')}</Button>
        <span className="mx-1 h-6 w-px bg-border" aria-hidden />
        <Button variant="outline" onClick={() => void act({ action: 'flush' })}>{t('Retry all')}</Button>
        <Button variant="outline" disabled={items.length === 0} onClick={() => setConfirming('delete-all')}>{t('Delete all')}</Button>
        <LoadingButton variant="ghost" loading={queue.isFetching} onClick={() => void queue.refetch()}>
          <RefreshCw aria-hidden />{t('Refresh')}</LoadingButton>
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
                  aria-label={t('Select all')}
                  checked={selected.size === items.length}
                  onCheckedChange={(v) => setSelected(v === true ? new Set(items.map((i) => i.id)) : new Set())}
                />
              </TableHead>
              <TableHead>{t('Queue ID')}</TableHead>
              <TableHead>{t('Queue')}</TableHead>
              <TableHead>{t('Arrived')}</TableHead>
              <TableHead>{t('Size')}</TableHead>
              <TableHead>{t('Sender')}</TableHead>
              <TableHead className="pr-4">{t('Recipients and reason')}</TableHead>
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
          title={t('The mail queue is empty')}
          description={queue.data?.at ? `As of ${formatDate(queue.data.at)}.` : 'Postfix has not reported its queue yet.'}
        />
      )}
      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming === 'delete-all' ? 'Delete every queued message?' : `Delete ${ids.length} queued messages?`}
        description={t('They are not delivered, and their senders are not told.')}
        onConfirm={async () => {
          if (confirming === 'delete-all') await act({ action: 'delete-all' });
          else await act({ action: 'delete', ids });
        }}
      />
    </div>
  );
}
