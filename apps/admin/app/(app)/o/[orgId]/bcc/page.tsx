'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { FieldGroup } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { FormSelect, FormSelectOption } from '@postarix/ui/components/select';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Plus, Power, Trash2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { AppDialog } from '@/components/app-dialog';
import { ConfirmDialog } from '@/components/confirm';
import { EmptyState } from '@/components/empty-state';
import { FormField } from '@/components/form-field';
import { ListTable } from '@/components/list-table';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { api, errorMessage } from '@/lib/api';
import { t } from '@/lib/i18n';
import { keys, useOrgList } from '@/lib/queries';
import type { BccRule } from '@/lib/types';

function NewRuleDialog({ orgId, open, onClose }: { orgId: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/bcc-rules`, {
        address: String(data.get('address') ?? ''),
        direction: String(data.get('direction') ?? 'recipient'),
        destination: String(data.get('destination') ?? ''),
      });
      void queryClient.invalidateQueries({ queryKey: keys.orgPart(orgId, 'bcc-rules') });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <AppDialog open={open} onClose={onClose} title={t('New copy rule')} description={t('A blind copy of every matching message goes to another address. Senders and recipients do not see it.')}>
      <form onSubmit={submit}>
        <FieldGroup>
          {error ? <Notice>{error}</Notice> : null}
          <FormField label={t('Copy mail')}>
            {(props) => (
              <FormSelect {...props} name="direction" defaultValue="recipient" className="w-full">
                <FormSelectOption value="recipient">{t('received by')}</FormSelectOption>
                <FormSelectOption value="sender">{t('sent by')}</FormSelectOption>
              </FormSelect>
            )}
          </FormField>
          <FormField label={t('Address')} hint={t('An address of one of your domains, or @domain for all of its addresses.')}>
            {(props) => <Input {...props} name="address" required placeholder="sales@example.com" autoComplete="off" />}
          </FormField>
          <FormField label={t('Copy to')} hint={t('Any address, here or elsewhere.')}>
            {(props) => <Input {...props} name="destination" type="email" required placeholder="manager@example.com" autoComplete="off" />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <LoadingButton type="submit" loading={pending}>
              {t('Add rule')}
            </LoadingButton>
          </DialogFooter>
        </FieldGroup>
      </form>
    </AppDialog>
  );
}

export default function BccRulesPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const queryClient = useQueryClient();
  const rules = useOrgList<BccRule>(orgId, 'bcc-rules');
  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.orgPart(orgId, 'bcc-rules') });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<BccRule | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title={t('Copies (BCC)')}
        description={t('Automatic blind copies of the mail an address or a whole domain sends or receives. The archive, if on, gets its copies too.')}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t('New rule')}
          </Button>
        }
      />
      {error ? <Notice>{error}</Notice> : null}
      {rules.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : rules.error ? (
        <Notice>{errorMessage(rules.error)}</Notice>
      ) : rules.data?.length ? (
        <ListTable>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">{t('Mail')}</TableHead>
              <TableHead>{t('Copy to')}</TableHead>
              <TableHead>{t('Status')}</TableHead>
              <TableHead className="pr-4 text-right">
                <span className="sr-only">{t('Actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.data.map((rule) => (
              <TableRow key={rule.id}>
                <TableCell className="pl-4">
                  <span className="text-muted-foreground">{rule.direction === 'sender' ? t('sent by') : t('received by')}</span>{' '}
                  <span className="font-medium">{rule.address}</span>
                </TableCell>
                <TableCell>{rule.destination}</TableCell>
                <TableCell>
                  {rule.enabled ? <Badge variant="success">{t('Enabled')}</Badge> : <Badge variant="secondary">{t('Disabled')}</Badge>}
                </TableCell>
                <TableCell className="pr-4">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`${rule.enabled ? t('Disable') : t('Enable')}: ${rule.address} → ${rule.destination}`}
                      onClick={async () => {
                        setError(null);
                        try {
                          await api.patch(`/orgs/${orgId}/bcc-rules/${rule.id}`, { enabled: !rule.enabled });
                          refresh();
                        } catch (e) {
                          setError(errorMessage(e));
                        }
                      }}
                    >
                      <Power aria-hidden />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`${t('Delete')}: ${rule.address} → ${rule.destination}`} onClick={() => setDeleting(rule)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ListTable>
      ) : (
        <EmptyState icon={Copy} title={t('No copy rules')} description={t('Send a copy of a mailbox\'s or a domain\'s mail to someone else, e.g. a manager or a compliance address.')} />
      )}
      <NewRuleDialog orgId={orgId} open={creating} onClose={() => setCreating(false)} />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t('Delete this rule?')}
        description={t('Copies stop within a few seconds.')}
        onConfirm={async () => {
          if (!deleting) return;
          await api.delete(`/orgs/${orgId}/bcc-rules/${deleting.id}`);
          refresh();
        }}
      />
    </>
  );
}
