'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Input } from '@postarix/ui/components/input';
import { FormSelect, FormSelectOption } from '@postarix/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { LockOpen, Plus } from 'lucide-react';
import { useState } from 'react';
import { FormField } from '@/components/form-field';
import { LoadingButton } from '@/components/loading-button';
import { PageHeader } from '@/components/page-header';
import { EnabledSwitch, FormDialog, ListCard, RemoveButton, useSystemList } from '@/components/system/policy';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { t } from '@/lib/i18n';

interface IpAccessEntry {
  id: string;
  network: string;
  kind: 'allow' | 'block';
  note: string;
  enabled: boolean;
  createdAt: string;
}

interface Lockout {
  kind: 'web-sign-in' | 'mail-login';
  subject: string;
  failures: number;
  locked: boolean;
  expiresAt: string;
}

const LOCKOUT_KIND: Record<Lockout['kind'], string> = {
  'web-sign-in': t('Panel and webmail'),
  'mail-login': t('Mail apps'),
};

function Unlock({ lockout, onDone }: { lockout: Lockout; onDone: () => unknown }) {
  const [pending, setPending] = useState(false);
  return (
    <LoadingButton
      size="sm"
      variant="outline"
      loading={pending}
      onClick={async () => {
        setPending(true);
        try {
          await api.delete(`/system/lockouts/${lockout.kind}/${encodeURIComponent(lockout.subject)}`);
          await onDone();
        } finally {
          setPending(false);
        }
      }}
    >
      <LockOpen aria-hidden />
      {lockout.locked ? t('Unlock') : t('Forget')}
    </LoadingButton>
  );
}

export default function IpAccessPage() {
  const entries = useSystemList<IpAccessEntry>('ip-access');
  const lockouts = useSystemList<Lockout>('lockouts');
  const [adding, setAdding] = useState<'allow' | 'block' | null>(null);

  return (
    <>
      <PageHeader
        title={t('IP access')}
        description={t('Networks refused everywhere (sending mail, the panel, the webmail), networks never refused by the client checks, and accounts locked after wrong passwords.')}
        actions={
          <>
            <Button variant="outline" onClick={() => setAdding('allow')}>
              <Plus aria-hidden />
              {t('Allow a network')}
            </Button>
            <Button onClick={() => setAdding('block')}>
              <Plus aria-hidden />
              {t('Block a network')}
            </Button>
          </>
        }
      />
      <div className="space-y-4">
        <ListCard
          title={t('Allowed and blocked networks')}
          description={t('A block wins over an allow. You cannot block the address you are using now.')}
          query={entries}
          empty={t('No networks listed.')}
        >
          {(rows) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">{t('Network')}</TableHead>
                  <TableHead>{t('Access')}</TableHead>
                  <TableHead>{t('Note')}</TableHead>
                  <TableHead>{t('Added')}</TableHead>
                  <TableHead>{t('On')}</TableHead>
                  <TableHead className="pr-6 text-right">
                    <span className="sr-only">{t('Actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="pl-6 font-mono text-sm">{e.network}</TableCell>
                    <TableCell>
                      <Badge variant={e.kind === 'block' ? 'destructive' : 'success'}>{e.kind === 'block' ? t('Blocked') : t('Allowed')}</Badge>
                    </TableCell>
                    <TableCell className="max-w-64 truncate text-sm text-muted-foreground">{e.note}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatDate(e.createdAt)}</TableCell>
                    <TableCell>
                      <EnabledSwitch url={`/system/ip-access/${e.id}`} enabled={e.enabled} label={t('On')} onDone={entries.refresh} />
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <RemoveButton url={`/system/ip-access/${e.id}`} title={t('Remove this network?')} onDone={entries.refresh} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </ListCard>

        <ListCard
          title={t('Locked accounts')}
          description={t('Accounts with wrong passwords lately. Locked ones are refused, even with the right password, until the time shown (Settings → Sign-in protection).')}
          query={lockouts}
          empty={t('No recent failed sign-ins.')}
        >
          {(rows) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">{t('Account')}</TableHead>
                  <TableHead>{t('Where')}</TableHead>
                  <TableHead>{t('Failed passwords')}</TableHead>
                  <TableHead>{t('Until')}</TableHead>
                  <TableHead className="pr-6 text-right">
                    <span className="sr-only">{t('Actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((l) => (
                  <TableRow key={`${l.kind}:${l.subject}`}>
                    <TableCell className="pl-6 font-medium">{l.subject}</TableCell>
                    <TableCell className="text-sm">{LOCKOUT_KIND[l.kind]}</TableCell>
                    <TableCell>
                      <Badge variant={l.locked ? 'destructive' : 'secondary'}>
                        {l.failures} {l.locked ? `· ${t('Locked')}` : ''}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatDate(l.expiresAt)}</TableCell>
                    <TableCell className="pr-6 text-right">
                      <Unlock lockout={l} onDone={lockouts.refresh} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </ListCard>
      </div>
      <FormDialog
        open={adding !== null}
        onClose={() => setAdding(null)}
        title={adding === 'allow' ? t('Allow a network') : t('Block a network')}
        description={
          adding === 'allow'
            ? t('Mail servers there skip the client checks. Spam filtering and sign-in still apply.')
            : t('Refused when sending mail here, and by the panel and the webmail.')
        }
        submitLabel={adding === 'allow' ? t('Allow') : t('Block')}
        onSubmit={async (data) => {
          await api.post('/system/ip-access', { network: String(data.get('network')), kind: String(data.get('kind')), note: String(data.get('note') ?? '') });
          await entries.refresh();
        }}
      >
        <FormField label={t('Network')} hint={t('An address (203.0.113.7) or a network (203.0.113.0/24, 2001:db8::/32).')}>
          {(props) => <Input {...props} name="network" required maxLength={64} className="font-mono" />}
        </FormField>
        <FormField label={t('Access')}>
          {(props) => (
            <FormSelect {...props} name="kind" defaultValue={adding ?? 'block'} className="w-full">
              <FormSelectOption value="block">{t('Blocked')}</FormSelectOption>
              <FormSelectOption value="allow">{t('Allowed')}</FormSelectOption>
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
