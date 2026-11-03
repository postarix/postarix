'use client';

import { PageHeader } from '@/components/page-header';
import { t } from '@/lib/i18n';
import { ApiKeysTab } from '../api-keys';

export default function ApiKeysPage() {
  return (
    <>
      <PageHeader title={t('API keys')} description={t('Keys for scripts and other software that manage this server through the API.')} />
      <ApiKeysTab />
    </>
  );
}
