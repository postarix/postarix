'use client';

import { PageHeader } from '@/components/page-header';
import { t } from '@/lib/i18n';
import { SettingsTab } from '../settings';

export default function SettingsPage() {
  return (
    <>
      <PageHeader title={t('Settings')} description={t('Branding, the announcement, sign-in and password rules of this server.')} />
      <SettingsTab />
    </>
  );
}
