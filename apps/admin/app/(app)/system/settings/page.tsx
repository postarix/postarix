'use client';

import { PageHeader } from '@/components/page-header';
import { t } from '@/lib/i18n';
import { SettingsTab } from '../settings';

export default function SettingsPage() {
  return (
    <>
      <PageHeader title={t('Settings')} description={t('Sign-in protection, password rules and the quota notice of this server.')} />
      <SettingsTab />
    </>
  );
}
