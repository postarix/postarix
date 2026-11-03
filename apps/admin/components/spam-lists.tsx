'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { LoadingButton } from './loading-button';
import { Notice } from './notice';
import { t } from '@/lib/i18n';

export interface SpamListEntry {
  id: string;
  kind: 'allow' | 'block';
  pattern: string;
}

/**
 * Allow and block lists of senders, for one target: `listUrl` lists them,
 * `addUrl` adds one (with `extra` fields), `deleteUrl(id)` removes one.
 */
export function SpamLists({
  queryKey,
  listUrl,
  addUrl,
  deleteUrl,
  extra = {},
}: {
  queryKey: readonly unknown[];
  listUrl: string;
  addUrl: string;
  deleteUrl: (id: string) => string;
  extra?: Record<string, string>;
}) {
  const queryClient = useQueryClient();
  const entries = useQuery({
    queryKey,
    queryFn: () => api.get<{ data: SpamListEntry[] }>(listUrl).then((r) => r.data),
  });
  const [pattern, setPattern] = useState('');
  const [kind, setKind] = useState<'allow' | 'block'>('block');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey });

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.post(addUrl, { ...extra, kind, pattern });
      setPattern('');
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('Blocked senders are refused. Allowed senders skip the spam filter, if they prove who they are (SPF or DMARC). Use an address,')}{' '}<code>@domain</code>{t(', or')}{' '}<code>@.domain</code>{' '}{t('for its subdomains.')}</p>
      <form onSubmit={add} className="flex flex-wrap gap-2">
        <NativeSelect aria-label={t('List')} value={kind} onChange={(e) => setKind(e.target.value as 'allow' | 'block')}>
          <NativeSelectOption value="block">{t('Block')}</NativeSelectOption>
          <NativeSelectOption value="allow">{t('Allow')}</NativeSelectOption>
        </NativeSelect>
        <Input
          aria-label={t('Sender')}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder={t('news@example.com or @example.com')}
          className="min-w-56 flex-1"
          required
        />
        <LoadingButton type="submit" variant="outline" loading={pending}>{t('Add')}</LoadingButton>
      </form>
      {error ? <Notice>{error}</Notice> : null}
      {entries.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : entries.error ? (
        <Notice>{errorMessage(entries.error)}</Notice>
      ) : entries.data?.length ? (
        <ul className="divide-y rounded-md border">
          {entries.data.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
              <span className="flex items-center gap-2">
                <Badge variant={entry.kind === 'allow' ? 'success' : 'destructive'}>{entry.kind === 'allow' ? 'Allow' : 'Block'}</Badge>
                <span className="font-mono text-xs">{entry.pattern}</span>
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove ${entry.pattern}`}
                onClick={async () => {
                  try {
                    await api.delete(deleteUrl(entry.id));
                    refresh();
                  } catch (e) {
                    setError(errorMessage(e));
                  }
                }}
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t('No senders listed.')}</p>
      )}
    </div>
  );
}
