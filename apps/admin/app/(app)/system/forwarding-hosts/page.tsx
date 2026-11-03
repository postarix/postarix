'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { Field, FieldLabel } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { FormField } from '@/components/form-field';
import { PageHeader } from '@/components/page-header';
import { EnabledSwitch, FormDialog, ListCard, RemoveButton, useSystemList } from '@/components/system/policy';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';

interface ForwardingHost {
  id: string;
  host: string;
  spamFilter: boolean;
  enabled: boolean;
  note: string;
  addresses: string[];
}

export default function ForwardingHostsPage() {
  const hosts = useSystemList<ForwardingHost>('forwarding-hosts');
  const [adding, setAdding] = useState(false);

  return (
    <>
      <PageHeader
        title={t('Forwarding hosts')}
        description={t('Servers that forward mail here, such as another provider where people keep a forwarding rule. Their mail is never greylisted or refused as spam.')}
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            {t('Add host')}
          </Button>
        }
      />
      <ListCard
        title={t('Hosts')}
        description={t('Host names are looked up again every 10 minutes. With the spam filter off, their mail is not scanned at all.')}
        query={hosts}
        empty={t('No forwarding hosts. Mail from every server is filtered the same way.')}
      >
        {(rows) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">{t('Host')}</TableHead>
                <TableHead>{t('Spam filter')}</TableHead>
                <TableHead>{t('Note')}</TableHead>
                <TableHead>{t('On')}</TableHead>
                <TableHead className="pr-6 text-right">
                  <span className="sr-only">{t('Actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((h) => (
                <TableRow key={h.id}>
                  <TableCell className="pl-6">
                    <span className="font-mono text-sm">{h.host}</span>
                    {h.addresses.length ? <span className="block font-mono text-xs text-muted-foreground">{h.addresses.join(', ')}</span> : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={h.spamFilter ? 'secondary' : 'warning'}>{h.spamFilter ? t('Scanned, never refused') : t('Not scanned')}</Badge>
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-sm text-muted-foreground">{h.note}</TableCell>
                  <TableCell>
                    <EnabledSwitch url={`/system/forwarding-hosts/${h.id}`} enabled={h.enabled} label={t('On')} onDone={hosts.refresh} />
                  </TableCell>
                  <TableCell className="pr-6 text-right">
                    <RemoveButton url={`/system/forwarding-hosts/${h.id}`} title={t('Remove this forwarding host?')} onDone={hosts.refresh} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ListCard>
      <FormDialog
        open={adding}
        onClose={() => setAdding(false)}
        title={t('Add a forwarding host')}
        submitLabel={t('Add host')}
        onSubmit={async (data) => {
          await api.post('/system/forwarding-hosts', {
            host: String(data.get('host')),
            spamFilter: data.get('spamFilter') === null,
            note: String(data.get('note') ?? ''),
          });
          await hosts.refresh();
        }}
      >
        <FormField label={t('Host')} hint={t('An address (192.0.2.10), a network (192.0.2.0/24) or a host name (mx.example.com).')}>
          {(props) => <Input {...props} name="host" required maxLength={253} className="font-mono" />}
        </FormField>
        <Field orientation="horizontal">
          <Checkbox id="spamFilter" name="spamFilter" />
          <FieldLabel htmlFor="spamFilter" className="font-normal">
            {t('Do not scan its mail at all')}
          </FieldLabel>
        </Field>
        <FormField label={t('Note')}>
          {(props) => <Input {...props} name="note" maxLength={200} />}
        </FormField>
      </FormDialog>
    </>
  );
}
