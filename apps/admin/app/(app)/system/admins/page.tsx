'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Input } from '@postarix/ui/components/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { FormField } from '@/components/form-field';
import { PageHeader } from '@/components/page-header';
import { FormDialog, ListCard, RemoveButton, useSystemList } from '@/components/system/policy';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { formatDate } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useBranding } from '@/lib/queries';

interface Admin {
  id: string;
  name: string;
  email: string;
  twoFactorEnabled: boolean;
  banned: boolean;
  createdAt: string;
}

export default function AdminsPage() {
  const admins = useSystemList<Admin>('admins');
  const { data: session } = useSession();
  const branding = useBranding();
  const [adding, setAdding] = useState(false);

  return (
    <>
      <PageHeader
        title={t('Administrators')}
        description={t('People who manage the whole server: every organization, and every page under Server.')}
        actions={
          <Button onClick={() => setAdding(true)}>
            <UserPlus aria-hidden />
            {t('Add administrator')}
          </Button>
        }
      />
      <ListCard
        title={t('Instance administrators')}
        description={t('They need two-step verification for some pages, such as the Rspamd web interface. Removing someone signs them out.')}
        query={admins}
        empty={t('None.')}
      >
        {(rows) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">{t('Name')}</TableHead>
                <TableHead>{t('Two-step verification')}</TableHead>
                <TableHead>{t('Since')}</TableHead>
                <TableHead className="pr-6 text-right">
                  <span className="sr-only">{t('Actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="pl-6">
                    <span className="block font-medium">
                      {a.name}
                      {a.id === session?.user.id ? <span className="ml-2 text-xs font-normal text-muted-foreground">({t('you')})</span> : null}
                    </span>
                    <span className="block text-xs text-muted-foreground">{a.email}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={a.twoFactorEnabled ? 'success' : 'warning'}>{a.twoFactorEnabled ? t('On') : t('Off')}</Badge>
                    {a.banned ? (
                      <Badge variant="destructive" className="ml-1">
                        {t('Banned')}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(a.createdAt)}</TableCell>
                  <TableCell className="pr-6 text-right">
                    {a.id === session?.user.id || rows.length <= 1 ? null : (
                      <RemoveButton
                        url={`/system/admins/${a.id}`}
                        title={t('Remove the administrator rights of {name}?').replace('{name}', a.email)}
                        description={t('The account stays, with its mailbox and organizations. They are signed out.')}
                        onDone={admins.refresh}
                      />
                    )}
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
        title={t('Add an administrator')}
        description={t('An existing account (say, someone’s mailbox) gets the rights; for a new address, give a name and a password.')}
        submitLabel={t('Add administrator')}
        onSubmit={async (data) => {
          const name = String(data.get('name') ?? '').trim();
          const password = String(data.get('password') ?? '');
          await api.post('/system/admins', {
            email: String(data.get('email')),
            ...(name ? { name } : {}),
            ...(password ? { password } : {}),
          });
          await admins.refresh();
        }}
      >
        <FormField label={t('Email')}>
          {(props) => <Input {...props} name="email" type="email" required autoComplete="off" />}
        </FormField>
        <FormField label={t('Name')} hint={t('Only for a new account.')}>
          {(props) => <Input {...props} name="name" maxLength={100} autoComplete="off" />}
        </FormField>
        <FormField
          label={t('Password')}
          hint={`${t('Only for a new account.')} ${t('At least {n} characters.').replace('{n}', String(branding.data?.passwordMinLength ?? 12))}`}
        >
          {(props) => <Input {...props} name="password" type="password" autoComplete="new-password" />}
        </FormField>
      </FormDialog>
    </>
  );
}
