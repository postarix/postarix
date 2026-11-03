'use client';

import { DomainTemplateFields, type DomainTemplateSettings, domainSettingsFrom, TemplateList } from '@/components/templates';
import { PageHeader } from '@/components/page-header';
import { t } from '@/lib/i18n';

export default function TemplatesPage() {
  return (
    <>
      <PageHeader title={t('Domain templates')} description={t('Settings and limits for new domains.')} />
      <div className="max-w-3xl">
        <TemplateList<DomainTemplateSettings>
          url="/system/domain-templates"
          queryKey={['system', 'domain-templates']}
          description={t('Settings and limits for new domains. The default template applies to every domain an organization adds; instance administrators can choose another when they add one.')}
          fields={(settings) => <DomainTemplateFields settings={settings} />}
          read={domainSettingsFrom}
        />
      </div>
    </>
  );
}
