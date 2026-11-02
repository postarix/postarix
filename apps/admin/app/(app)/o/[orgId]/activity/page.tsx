'use client';

import { Alert, Button, Card, EmptyState, PageHeader, Spinner, Table, Td, Th } from '@postarix/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
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
        .get<{ data: AuditEvent[] }>(
          `/orgs/${orgId}/audit?limit=${PAGE}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`,
        )
        .then((r) => r.data),
    getNextPageParam: (last) => (last.length === PAGE ? (last.at(-1)?.createdAt ?? null) : null),
  });
  const rows = events.data?.pages.flat() ?? [];

  return (
    <>
      <PageHeader title="Activity" description="Every change made in this organization, newest first." />
      {events.isLoading ? (
        <Spinner />
      ) : events.error ? (
        <Alert>{errorMessage(events.error)}</Alert>
      ) : rows.length ? (
        <>
          <Card className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Action</Th>
                  <Th>Target</Th>
                  <Th>By</Th>
                  <Th>IP</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((event) => (
                  <tr key={event.id}>
                    <Td className="whitespace-nowrap text-sm text-ink-muted">{formatDate(event.createdAt)}</Td>
                    <Td className="text-sm">{describe(event)}</Td>
                    <Td className="text-sm font-medium">{event.targetLabel ?? '—'}</Td>
                    <Td className="text-sm">{event.actorEmail ?? 'System'}</Td>
                    <Td className="font-mono text-xs text-ink-muted">{event.ipAddress ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          {events.hasNextPage ? (
            <div className="mt-4 flex justify-center">
              <Button variant="secondary" loading={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
                Load more
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <EmptyState title="Nothing has happened yet" />
      )}
    </>
  );
}
