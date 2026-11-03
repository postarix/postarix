'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Input } from '@postarix/ui/components/input';
import { FormSelect, FormSelectOption } from '@postarix/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { FormField } from '@/components/form-field';
import { PageHeader } from '@/components/page-header';
import { EnabledSwitch, FormDialog, ListCard, RemoveButton, useSystemList } from '@/components/system/policy';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';

interface FilterRule {
  id: string;
  target: 'subject' | 'from' | 'to' | 'header';
  header: string | null;
  pattern: string;
  action: 'reject' | 'junk';
  note: string;
  enabled: boolean;
}

const TARGET: Record<FilterRule['target'], string> = {
  subject: t('Subject'),
  from: t('Sender'),
  to: t('Recipients'),
  header: t('Header'),
};

export default function FiltersPage() {
  const rules = useSystemList<FilterRule>('filter-rules');
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState<FilterRule['target']>('subject');

  return (
    <>
      <PageHeader
        title={t('Content filters')}
        description={t('Regular expressions checked on all incoming mail. Matching mail is refused or filed as junk, whoever it is for.')}
        actions={
          <Button
            onClick={() => {
              setTarget('subject');
              setAdding(true);
            }}
          >
            <Plus aria-hidden />
            {t('Add rule')}
          </Button>
        }
      />
      <ListCard
        title={t('Rules')}
        description={t('Checked case-insensitively on mail from other servers; mail your own people send is never checked.')}
        query={rules}
        empty={t('No rules. Only the spam filter decides.')}
      >
        {(rows) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">{t('Checks')}</TableHead>
                <TableHead>{t('Pattern')}</TableHead>
                <TableHead>{t('Then')}</TableHead>
                <TableHead>{t('Note')}</TableHead>
                <TableHead>{t('On')}</TableHead>
                <TableHead className="pr-6 text-right">
                  <span className="sr-only">{t('Actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-6 text-sm">
                    {TARGET[r.target]}
                    {r.header ? <span className="ml-1 font-mono text-xs text-muted-foreground">{r.header}</span> : null}
                  </TableCell>
                  <TableCell className="max-w-80">
                    <code className="block truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs" title={r.pattern}>
                      {r.pattern}
                    </code>
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.action === 'reject' ? 'destructive' : 'warning'}>{r.action === 'reject' ? t('Refuse') : t('File as junk')}</Badge>
                  </TableCell>
                  <TableCell className="max-w-48 truncate text-sm text-muted-foreground">{r.note}</TableCell>
                  <TableCell>
                    <EnabledSwitch url={`/system/filter-rules/${r.id}`} enabled={r.enabled} label={t('On')} onDone={rules.refresh} />
                  </TableCell>
                  <TableCell className="pr-6 text-right">
                    <RemoveButton url={`/system/filter-rules/${r.id}`} title={t('Delete this rule?')} onDone={rules.refresh} />
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
        title={t('Add a content rule')}
        submitLabel={t('Add rule')}
        onSubmit={async (data) => {
          await api.post('/system/filter-rules', {
            target,
            ...(target === 'header' ? { header: String(data.get('header') ?? '') } : {}),
            pattern: String(data.get('pattern')),
            action: String(data.get('action')),
            note: String(data.get('note') ?? ''),
          });
          await rules.refresh();
        }}
      >
        <FormField label={t('Check')}>
          {(props) => (
            <FormSelect {...props} value={target} onValueChange={(v) => setTarget(v as FilterRule['target'])} className="w-full">
              <FormSelectOption value="subject">{t('Subject')}</FormSelectOption>
              <FormSelectOption value="from">{t('Sender (address and name)')}</FormSelectOption>
              <FormSelectOption value="to">{t('Recipients')}</FormSelectOption>
              <FormSelectOption value="header">{t('A header')}</FormSelectOption>
            </FormSelect>
          )}
        </FormField>
        {target === 'header' ? (
          <FormField label={t('Header name')}>
            {(props) => <Input {...props} name="header" required placeholder="X-Mailer" maxLength={100} className="font-mono" />}
          </FormField>
        ) : null}
        <FormField label={t('Regular expression')} hint={t('E.g. (casino|lottery) or ^Invoice [0-9]+. Case does not matter.')}>
          {(props) => <Input {...props} name="pattern" required maxLength={500} className="font-mono" />}
        </FormField>
        <FormField label={t('Then')}>
          {(props) => (
            <FormSelect {...props} name="action" defaultValue="junk" className="w-full">
              <FormSelectOption value="junk">{t('File as junk')}</FormSelectOption>
              <FormSelectOption value="reject">{t('Refuse')}</FormSelectOption>
            </FormSelect>
          )}
        </FormField>
        <FormField label={t('Note')}>
          {(props) => <Input {...props} name="note" maxLength={200} />}
        </FormField>
      </FormDialog>
    </>
  );
}
