'use client';

import { PageHeader } from '@/components/page-header';
import { t } from '@/lib/i18n';
import { QuarantineSettings } from '../settings';

export default function QuarantineSettingsPage() {
  return (
    <>
      <PageHeader title={t('Quarantine')} description={t('How long refused spam is kept, who hears about it, and how it is released.')} />
      <QuarantineSettings />
    </>
  );
}
