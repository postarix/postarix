'use client';

import { PageHeader } from '@/components/page-header';
import { t } from '@/lib/i18n';
import { RoutingTab } from '../routing';

export default function RoutingPage() {
  return (
    <>
      <PageHeader title={t('Outgoing routing')} description={t('Smart hosts, routes per destination, recipient rewrites and TLS policies for the whole server.')} />
      <RoutingTab />
    </>
  );
}
