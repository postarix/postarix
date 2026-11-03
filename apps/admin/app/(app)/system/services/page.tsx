'use client';

import { Skeleton } from '@postarix/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { ServiceList, type ServiceStatus } from '@/components/system/services';
import { api, errorMessage } from '@/lib/api';
import { t } from '@/lib/i18n';

export default function ServicesPage() {
  const status = useQuery({
    queryKey: ['system', 'status'],
    queryFn: () => api.get<{ data: ServiceStatus[] }>('/system/status').then((r) => r.data),
    refetchInterval: 30_000,
  });
  return (
    <>
      <PageHeader
        title={t('Services')}
        description={t('Every part of the mail server, whether it answers, its version and its disk. The mail containers report every 15 seconds.')}
        actions={
          <LoadingButton variant="outline" loading={status.isFetching} onClick={() => void status.refetch()}>
            <RefreshCw aria-hidden />
            {t('Refresh')}
          </LoadingButton>
        }
      />
      {status.error ? (
        <Notice>{errorMessage(status.error)}</Notice>
      ) : status.data ? (
        <ServiceList services={status.data} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-56 rounded-xl" />
          ))}
        </div>
      )}
    </>
  );
}
