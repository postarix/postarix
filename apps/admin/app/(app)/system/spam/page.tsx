'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@postarix/ui/components/card';
import { PageHeader } from '@/components/page-header';
import { SpamLists } from '@/components/spam-lists';
import { t } from '@/lib/i18n';

export default function SpamPage() {
  return (
    <>
      <PageHeader title={t('Spam filter')} description={t('Rules for every mailbox on this server. Organizations and people add their own on top.')} />
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>{t('Senders for every mailbox on this server')}</CardTitle>
          <CardDescription>{t('Blocked senders are refused everywhere; allowed ones skip the spam filter.')}</CardDescription>
        </CardHeader>
        <CardContent>
          <SpamLists queryKey={['system', 'spam-lists']} listUrl="/system/spam-lists" addUrl="/system/spam-lists" deleteUrl={(id) => `/system/spam-lists/${id}`} />
        </CardContent>
      </Card>
    </>
  );
}
