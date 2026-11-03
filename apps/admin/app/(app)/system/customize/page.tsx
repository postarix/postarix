'use client';

import { PageHeader } from '@/components/page-header';
import { t } from '@/lib/i18n';
import { CustomizeSettings } from '../settings';

export default function CustomizePage() {
  return (
    <>
      <PageHeader title={t('Customize')} description={t('Your name and logo, the sign-in pages, the announcement and links to your other apps.')} />
      <CustomizeSettings />
    </>
  );
}
