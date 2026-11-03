'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { FieldGroup } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { Textarea } from '@postarix/ui/components/textarea';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { AppDialog } from '@/components/app-dialog';
import { ConfirmDialog } from '@/components/confirm';
import { CopyButton } from '@/components/copy-button';
import { FormField } from '@/components/form-field';
import { ListTable } from '@/components/list-table';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { t } from '@/lib/i18n';

interface ApiKey {
  id: string;
  name: string;
  access: 'read' | 'write';
  allowedIps: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/** Keys for software to use the API as an instance administrator. */
export function ApiKeysTab() {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ['system', 'api-keys'], queryFn: () => api.get<{ data: ApiKey[] }>('/system/api-keys').then((r) => r.data) });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ApiKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['system', 'api-keys'] });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const days = String(data.get('expiresInDays') ?? '').trim();
    setPending(true);
    setError(null);
    try {
      const res = await api.post<{ key: string }>('/system/api-keys', {
        name: String(data.get('name')),
        access: String(data.get('access')),
        allowedIps: String(data.get('allowedIps') ?? '')
          .split(/[\s,]+/)
          .filter(Boolean),
        ...(days ? { expiresInDays: Number(days) } : {}),
      });
      setCreated(res.key);
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t('Scripts and other software call the same API as this panel with "Authorization: Bearer <key>", as the administrator who created the key. Read-only keys can only read.')}
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setCreated(null);
            setError(null);
            setCreating(true);
          }}
        >
          <Plus aria-hidden />
          {t('New API key')}
        </Button>
      </div>
      {keys.isLoading ? (
        <Skeleton className="h-20 w-full rounded-xl" />
      ) : keys.error ? (
        <Notice>{errorMessage(keys.error)}</Notice>
      ) : keys.data?.length ? (
        <ListTable>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">{t('Name')}</TableHead>
              <TableHead>{t('Access')}</TableHead>
              <TableHead>{t('Allowed from')}</TableHead>
              <TableHead>{t('Last used')}</TableHead>
              <TableHead>{t('Expires')}</TableHead>
              <TableHead className="pr-4 text-right">
                <span className="sr-only">{t('Actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.data.map((key) => (
              <TableRow key={key.id}>
                <TableCell className="pl-4 font-medium">{key.name}</TableCell>
                <TableCell>
                  <Badge variant={key.access === 'write' ? 'warning' : 'secondary'}>{key.access === 'write' ? t('Read and write') : t('Read only')}</Badge>
                </TableCell>
                <TableCell className="text-sm">{key.allowedIps.length ? key.allowedIps.join(', ') : t('Anywhere')}</TableCell>
                <TableCell className="text-sm">{formatDate(key.lastUsedAt)}</TableCell>
                <TableCell className="text-sm">{key.expiresAt ? formatDate(key.expiresAt) : t('Never')}</TableCell>
                <TableCell className="pr-4 text-right">
                  <Button size="icon-sm" variant="ghost" aria-label={t('Delete')} onClick={() => setDeleting(key)}>
                    <Trash2 aria-hidden />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ListTable>
      ) : (
        <p className="text-sm text-muted-foreground">{t('None.')}</p>
      )}
      {creating ? (
        <AppDialog open onClose={() => setCreating(false)} title={t('New API key')}>
          {created ? (
            <div className="space-y-3">
              <Notice tone="warning">{t('Copy it now: it is shown only once.')}</Notice>
              <div className="flex items-start gap-2">
                <code className="block font-mono text-xs break-all">{created}</code>
                <CopyButton value={created} />
              </div>
              <DialogFooter>
                <Button onClick={() => setCreating(false)}>{t('Done')}</Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={submit}>
              <FieldGroup>
                {error ? <Notice>{error}</Notice> : null}
                <FormField label={t('Name')} hint={t('What uses it, e.g. "Provisioning script".')}>
                  {(props) => <Input {...props} name="name" required maxLength={100} />}
                </FormField>
                <FormField label={t('Access')}>
                  {(props) => (
                    <NativeSelect {...props} name="access" defaultValue="read" className="w-full">
                      <NativeSelectOption value="read">{t('Read only')}</NativeSelectOption>
                      <NativeSelectOption value="write">{t('Read and write')}</NativeSelectOption>
                    </NativeSelect>
                  )}
                </FormField>
                <FormField label={t('Allowed from')} hint={t('IP addresses or networks (203.0.113.0/24), one per line. Empty: anywhere.')}>
                  {(props) => <Textarea {...props} name="allowedIps" rows={3} className="font-mono text-xs" />}
                </FormField>
                <FormField label={t('Expires after (days)')} hint={t('Empty: never.')}>
                  {(props) => <Input {...props} name="expiresInDays" type="number" min={1} max={3650} />}
                </FormField>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                    {t('Cancel')}
                  </Button>
                  <LoadingButton type="submit" loading={pending}>
                    {t('Create')}
                  </LoadingButton>
                </DialogFooter>
              </FieldGroup>
            </form>
          )}
        </AppDialog>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t('Delete this API key?')}
        description={t('Software using it stops working at once.')}
        onConfirm={async () => {
          if (!deleting) return;
          await api.delete(`/system/api-keys/${deleting.id}`);
          refresh();
        }}
      />
    </div>
  );
}
