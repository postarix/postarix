'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Inbox, ShieldCheck, Trash2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm';
import { EmptyState } from '@/components/empty-state';
import { ListTable } from '@/components/list-table';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatDate } from '@/lib/format';
import { keys } from '@/lib/queries';

interface QuarantineItem {
  id: string;
  recipient: string;
  envelopeFrom: string;
  fromHeader: string;
  subject: string;
  score: number;
  symbols: string[];
  sizeBytes: number;
  createdAt: string;
}

export default function QuarantinePage() {
  const { orgId } = useParams<{ orgId: string }>();
  const queryClient = useQueryClient();
  const queryKey = keys.orgPart(orgId, 'quarantine');
  const items = useQuery({
    queryKey,
    queryFn: () => api.get<{ data: QuarantineItem[] }>(`/orgs/${orgId}/quarantine`).then((r) => r.data),
  });
  const [releasing, setReleasing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<QuarantineItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey });

  return (
    <>
      <PageHeader
        title="Quarantine"
        description="Mail the spam filter refused for this organization's mailboxes, kept for a while. Release a message to deliver it to its recipient's inbox."
      />
      {error ? <Notice>{error}</Notice> : null}
      {items.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : items.error ? (
        <Notice>{errorMessage(items.error)}</Notice>
      ) : items.data?.length ? (
        <ListTable>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Received</TableHead>
              <TableHead>Recipient</TableHead>
              <TableHead>Sender and subject</TableHead>
              <TableHead>Score</TableHead>
              <TableHead className="pr-4 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.data.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="pl-4 text-sm">{formatDate(item.createdAt)}</TableCell>
                <TableCell className="text-sm">{item.recipient}</TableCell>
                <TableCell className="text-sm whitespace-normal">
                  <span className="block">{item.fromHeader || item.envelopeFrom || '(no sender)'}</span>
                  <span className="block text-muted-foreground">{item.subject || '(no subject)'}</span>
                  {item.symbols.length ? (
                    <span className="mt-1 block text-xs text-muted-foreground">{item.symbols.join(', ')}</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge variant="destructive">{item.score.toFixed(1)}</Badge>
                  <span className="block text-xs text-muted-foreground">{formatBytes(item.sizeBytes)}</span>
                </TableCell>
                <TableCell className="pr-4">
                  <div className="flex justify-end gap-1">
                    <LoadingButton
                      size="sm"
                      variant="outline"
                      loading={releasing === item.id}
                      onClick={async () => {
                        setReleasing(item.id);
                        setError(null);
                        try {
                          await api.post(`/orgs/${orgId}/quarantine/${item.id}/release`);
                          refresh();
                        } catch (e) {
                          setError(errorMessage(e));
                        } finally {
                          setReleasing(null);
                        }
                      }}
                    >
                      <ShieldCheck aria-hidden />
                      Release
                    </LoadingButton>
                    <Button size="icon-sm" variant="ghost" asChild>
                      <a href={`/api/orgs/${orgId}/quarantine/${item.id}/message`} aria-label={`Download ${item.subject}`}>
                        <Download aria-hidden />
                      </a>
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Delete ${item.subject}`} onClick={() => setDeleting(item)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ListTable>
      ) : (
        <EmptyState icon={Inbox} title="Nothing in quarantine" description="Refused spam appears here, for each recipient." />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this message?"
        description="It is removed from quarantine for good."
        onConfirm={async () => {
          if (!deleting) return;
          await api.delete(`/orgs/${orgId}/quarantine/${deleting.id}`);
          refresh();
        }}
      />
    </>
  );
}
