'use client';

import { Skeleton } from '@postarix/ui/components/skeleton';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { useInfiniteQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { useParams } from 'next/navigation';
import { EmptyState } from '@/components/empty-state';
import { ListTable } from '@/components/list-table';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { keys } from '@/lib/queries';
import type { AuditEvent } from '@/lib/types';

const PAGE = 50;

function describe(event: AuditEvent): string {
  const [type, verb] = event.action.split('.');
  const what = (type ?? '').replace(/_/g, ' ');
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} ${(verb ?? '').replace(/_/g, ' ')}`;
}

export default function ActivityPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const events = useInfiniteQuery({
    queryKey: keys.orgPart(orgId, 'audit'),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api
        .get<{ data: AuditEvent[] }>(`/orgs/${orgId}/audit?limit=${PAGE}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`)
        .then((r) => r.data),
    getNextPageParam: (last) => (last.length === PAGE ? (last.at(-1)?.createdAt ?? null) : null),
  });
  const rows = events.data?.pages.flat() ?? [];

  return (
    <>
      <PageHeader title="Activity" description="Every change made in this organization, newest first." />
      {events.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : events.error ? (
        <Notice>{errorMessage(events.error)}</Notice>
      ) : rows.length ? (
        <>
          <ListTable>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>By</TableHead>
                <TableHead className="pr-4">IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="pl-4 text-muted-foreground">{formatDate(event.createdAt)}</TableCell>
                  <TableCell>{describe(event)}</TableCell>
                  <TableCell className="font-medium">{event.targetLabel ?? '—'}</TableCell>
                  <TableCell>{event.actorEmail ?? 'System'}</TableCell>
                  <TableCell className="pr-4 font-mono text-xs text-muted-foreground">{event.ipAddress ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ListTable>
          {events.hasNextPage ? (
            <div className="mt-4 flex justify-center">
              <LoadingButton variant="outline" loading={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
                Load more
              </LoadingButton>
            </div>
          ) : null}
        </>
      ) : (
        <EmptyState icon={History} title="Nothing has happened yet" />
      )}
    </>
  );
}
