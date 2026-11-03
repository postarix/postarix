'use client';

import { PageHeader } from '@/components/page-header';
import { t } from '@/lib/i18n';
import { QueueTab } from '../sections';

export default function QueuePage() {
  return (
    <>
      <PageHeader title={t('Mail queue')} description={t('Messages Postfix is still trying to deliver, and why they wait.')} />
      <QueueTab />
    </>
  );
}
