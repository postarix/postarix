'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@postarix/ui/components/card';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { Spinner } from '@postarix/ui/components/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@postarix/ui/components/table';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import QRCode from 'qrcode';
import { type FormEvent, useEffect, useState } from 'react';
import { AppDialog } from '@/components/app-dialog';
import { ConfirmDialog } from '@/components/confirm';
import { CopyButton } from '@/components/copy-button';
import { EmptyState } from '@/components/empty-state';
import { FormField } from '@/components/form-field';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { PasswordInput } from '@/components/password-input';
import { api, errorMessage } from '@/lib/api';
import { authClient, useSession } from '@/lib/auth-client';
import { formatDate } from '@/lib/format';
import type { AppPassword } from '@/lib/types';
import { t } from '@/lib/i18n';

type Status = { tone: 'success' | 'destructive'; text: string } | null;

function ProfileCard() {
  const { data: session, refetch } = useSession();
  const [status, setStatus] = useState<Status>(null);
  const [pending, setPending] = useState(false);
  if (!session) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setStatus(null);
    const { error } = await authClient.updateUser({ name: String(new FormData(event.currentTarget).get('name')).trim() });
    setPending(false);
    if (error) return setStatus({ tone: 'destructive', text: error.message ?? 'Could not save' });
    await refetch();
    setStatus({ tone: 'success', text: 'Saved.' });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Profile')}</CardTitle>
        <CardDescription>{session.user.email}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit}>
          <FieldGroup>
            {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
            <FormField label={t('Name')}>
              {(props) => <Input {...props} name="name" defaultValue={session.user.name} required maxLength={128} />}
            </FormField>
            <div>
              <LoadingButton type="submit" loading={pending}>{t('Save')}</LoadingButton>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setStatus(null);
    const { error } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
    setPending(false);
    if (error) return setStatus({ tone: 'destructive', text: error.message ?? 'Could not change the password' });
    setCurrent('');
    setNext('');
    setStatus({ tone: 'success', text: 'Password changed. Other sessions were signed out.' });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Password')}</CardTitle>
        <CardDescription>{t('Also used by mail apps while two-factor authentication is off.')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit}>
          <FieldGroup>
            {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
            <FormField label={t('Current password')}>
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  required
                />
              )}
            </FormField>
            <FormField label={t('New password')} hint={t('At least 12 characters.')}>
              {(props) => <PasswordInput {...props} value={next} onChange={setNext} required />}
            </FormField>
            <div>
              <LoadingButton type="submit" loading={pending}>{t('Change password')}</LoadingButton>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

function QrCode({ value }: { value: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    void QRCode.toDataURL(value, { margin: 1, width: 192 }).then(setSrc);
  }, [value]);
  return src ? (
    <img src={src} alt={t('QR code for your authenticator app')} width={192} height={192} className="rounded-md bg-white p-1" />
  ) : (
    <Skeleton className="size-48" />
  );
}

function TwoFactorCard() {
  const { data: session, refetch } = useSession();
  const enabled = Boolean(session?.user.twoFactorEnabled);
  const [step, setStep] = useState<'idle' | 'password' | 'scan' | 'disable'>('idle');
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const close = () => {
    setStep('idle');
    setPassword('');
    setCode('');
    setSetup(null);
    setError(null);
  };

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { data, error: e } = await authClient.twoFactor.enable({ password });
    setPending(false);
    if (e || !data || !('totpURI' in data)) return setError(e?.message ?? 'Could not start the setup');
    setSetup({ totpURI: data.totpURI, backupCodes: data.backupCodes });
    setStep('scan');
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error: e } = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, '') });
    setPending(false);
    if (e) return setError(e.message ?? 'Invalid code');
    await refetch();
    close();
  }

  async function disable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error: e } = await authClient.twoFactor.disable({ password });
    setPending(false);
    if (e) return setError(e.message ?? 'Could not turn off two-factor authentication');
    await refetch();
    close();
  }

  const secret = setup ? (new URL(setup.totpURI).searchParams.get('secret') ?? '') : '';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">{t('Two-factor authentication')}{enabled ? <Badge variant="success">{t('On')}</Badge> : <Badge variant="secondary">{t('Off')}</Badge>}
        </CardTitle>
        <CardDescription>{t('With it on, mail apps need app passwords: your password alone can no longer read your mail.')}</CardDescription>
        <CardAction>
          {enabled ? (
            <Button variant="outline" onClick={() => setStep('disable')}>{t('Turn off')}</Button>
          ) : (
            <Button onClick={() => setStep('password')}>
              <ShieldCheck aria-hidden />{t('Turn on')}</Button>
          )}
        </CardAction>
      </CardHeader>

      <AppDialog
        open={step === 'password' || step === 'disable'}
        onClose={close}
        title={step === 'disable' ? 'Turn off two-factor authentication' : 'Confirm your password'}
      >
        <form onSubmit={step === 'disable' ? disable : start}>
          <FieldGroup>
            {error ? <Notice>{error}</Notice> : null}
            <FormField label={t('Password')}>
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoFocus
                />
              )}
            </FormField>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>{t('Cancel')}</Button>
              <LoadingButton type="submit" variant={step === 'disable' ? 'destructive' : 'default'} loading={pending}>
                {step === 'disable' ? 'Turn off' : 'Continue'}
              </LoadingButton>
            </DialogFooter>
          </FieldGroup>
        </form>
      </AppDialog>

      <AppDialog open={step === 'scan'} onClose={close} title={t('Set up your authenticator app')} description={t('Scan the code, then enter the 6 digits it shows.')}>
        {setup ? (
          <form onSubmit={confirm}>
            <FieldGroup>
              {error ? <Notice>{error}</Notice> : null}
              <div className="flex flex-col items-center gap-2">
                <QrCode value={setup.totpURI} />
                <code className="text-center text-xs break-all text-muted-foreground">{secret}</code>
              </div>
              <div>
                <p className="text-sm font-medium">{t('Backup codes')}</p>
                <p className="mb-2 text-sm text-muted-foreground">{t('Each works once if you lose your device. Store them somewhere safe.')}</p>
                <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-3 font-mono text-sm">
                  {setup.backupCodes.map((c) => (
                    <span key={c}>{c}</span>
                  ))}
                </div>
                <div className="mt-2">
                  <CopyButton value={setup.backupCodes.join('\n')} label={t('Copy codes')} />
                </div>
              </div>
              <FormField label={t('Code from the app')}>
                {(props) => (
                  <Input {...props} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required />
                )}
              </FormField>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close}>{t('Cancel')}</Button>
                <LoadingButton type="submit" loading={pending}>{t('Turn on')}</LoadingButton>
              </DialogFooter>
            </FieldGroup>
          </form>
        ) : null}
      </AppDialog>
    </Card>
  );
}

interface Passkey {
  id: string;
  name?: string | null;
  createdAt: string | Date;
}

function PasskeysCard() {
  const queryClient = useQueryClient();
  const passkeys = useQuery({
    queryKey: ['me', 'passkeys'],
    queryFn: async () => {
      const { data, error } = await authClient.passkey.listUserPasskeys();
      if (error) throw new Error(error.message ?? 'Could not load passkeys');
      return (data ?? []) as Passkey[];
    },
  });
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Passkey | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Passkeys')}</CardTitle>
        <CardDescription>{t('Sign in with your fingerprint, face or a security key instead of a password.')}</CardDescription>
        <CardAction>
          <LoadingButton
            variant="outline"
            loading={adding}
            onClick={async () => {
              setAdding(true);
              setError(null);
              const result = await authClient.passkey.addPasskey({ name: navigator.platform || 'Passkey' });
              setAdding(false);
              if (result?.error) setError(result.error.message ?? 'Could not add the passkey');
              await queryClient.invalidateQueries({ queryKey: ['me', 'passkeys'] });
            }}
          >
            <Fingerprint aria-hidden />{t('Add passkey')}</LoadingButton>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <Notice>{error}</Notice> : null}
        {passkeys.isLoading ? (
          <Spinner />
        ) : passkeys.data?.length ? (
          <ul className="divide-y">
            {passkeys.data.map((p) => (
              <li key={p.id} className="flex items-center justify-between py-2">
                <div>
                  <p className="text-sm font-medium">{p.name || 'Passkey'}</p>
                  <p className="text-xs text-muted-foreground">{t('Added')}{' '}{formatDate(new Date(p.createdAt).toISOString())}</p>
                </div>
                <Button size="icon-sm" variant="ghost" aria-label={`Remove passkey ${p.name ?? ''}`} onClick={() => setRemoving(p)}>
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('No passkeys yet.')}</p>
        )}
      </CardContent>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={t('Remove this passkey?')}
        description={t('You will no longer be able to sign in with it.')}
        confirmLabel={t('Remove')}
        onConfirm={async () => {
          if (!removing) return;
          const { error: e } = await authClient.passkey.deletePasskey({ id: removing.id });
          if (e) throw new Error(e.message ?? 'Could not remove the passkey');
          await queryClient.invalidateQueries({ queryKey: ['me', 'passkeys'] });
        }}
      />
    </Card>
  );
}

const scopeLabel = { imap: 'Mail (IMAP/POP3)', smtp: 'Sending (SMTP)', dav: 'Calendars & contacts' } as const;

function AppPasswordsCard() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['me', 'app-passwords'],
    queryFn: () => api.get<{ data: AppPassword[] }>('/me/app-passwords').then((r) => r.data),
  });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AppPassword | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const scopes = data.getAll('scopes').map(String);
    setPending(true);
    setError(null);
    try {
      const result = await api.post<{ password: string }>('/me/app-passwords', { name: String(data.get('name')), scopes });
      setCreated(result.password);
      await queryClient.invalidateQueries({ queryKey: ['me', 'app-passwords'] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  const closeCreate = () => {
    setCreating(false);
    setCreated(null);
    setError(null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('App passwords')}</CardTitle>
        <CardDescription>{t('One per mail app or device, so you can revoke a lost phone without changing your password.')}</CardDescription>
        <CardAction>
          <Button variant="outline" onClick={() => setCreating(true)}>
            <Plus aria-hidden />{t('New app password')}</Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {list.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : list.error ? (
          <Notice>{errorMessage(list.error)}</Notice>
        ) : list.data?.length ? (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Name')}</TableHead>
                  <TableHead>{t('Access')}</TableHead>
                  <TableHead>{t('Last used')}</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">{t('Actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {p.scopes.map((s) => (
                          <Badge key={s} variant="secondary">
                            {scopeLabel[s]}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.lastUsedAt ? formatDate(p.lastUsedAt) : 'Never'}</TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Button size="icon-sm" variant="ghost" aria-label={`Revoke ${p.name}`} onClick={() => setRevoking(p)}>
                          <Trash2 aria-hidden />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState icon={KeyRound} title={t('No app passwords')} description={t('Create one for each mail, calendar or contacts app you use.')} />
        )}
      </CardContent>

      <AppDialog open={creating} onClose={closeCreate} title={created ? 'Your new app password' : 'New app password'}>
        {created ? (
          <FieldGroup>
            <Notice tone="warning">{t('Copy it now: it is shown only once.')}</Notice>
            <div className="flex items-center justify-between gap-2 rounded-md bg-muted p-3">
              <code className="font-mono text-base tracking-wider" data-testid="app-password">
                {created}
              </code>
              <CopyButton value={created} />
            </div>
            <p className="text-sm text-muted-foreground">{t('Use your full email address as the user name in your mail app.')}</p>
            <DialogFooter>
              <Button onClick={closeCreate}>{t('Done')}</Button>
            </DialogFooter>
          </FieldGroup>
        ) : (
          <form onSubmit={submit}>
            <FieldGroup>
              {error ? <Notice>{error}</Notice> : null}
              <FormField label={t('Name')} hint={t('For example "Thunderbird on my laptop".')}>
                {(props) => <Input {...props} name="name" required maxLength={64} autoFocus />}
              </FormField>
              <FieldSet>
                <FieldLegend variant="label">{t('Access')}</FieldLegend>
                <FieldGroup className="gap-3">
                  {(Object.keys(scopeLabel) as (keyof typeof scopeLabel)[]).map((scope) => (
                    <Field key={scope} orientation="horizontal">
                      <Checkbox id={`scope-${scope}`} name="scopes" value={scope} defaultChecked={scope !== 'dav'} />
                      <FieldLabel htmlFor={`scope-${scope}`} className="font-normal">
                        {scopeLabel[scope]}
                      </FieldLabel>
                    </Field>
                  ))}
                </FieldGroup>
              </FieldSet>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={closeCreate}>{t('Cancel')}</Button>
                <LoadingButton type="submit" loading={pending}>
                  <KeyRound aria-hidden />{t('Create')}</LoadingButton>
              </DialogFooter>
            </FieldGroup>
          </form>
        )}
      </AppDialog>
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`Revoke "${revoking?.name ?? ''}"?`}
        description={t('Apps using it stop working immediately.')}
        confirmLabel={t('Revoke')}
        onConfirm={async () => {
          if (!revoking) return;
          await api.delete(`/me/app-passwords/${revoking.id}`);
          await queryClient.invalidateQueries({ queryKey: ['me', 'app-passwords'] });
        }}
      />
    </Card>
  );
}

export default function AccountPage() {
  return (
    <>
      <PageHeader title={t('Your account')} description={t('Sign-in security and access for mail apps.')} />
      <div className="grid gap-6 lg:grid-cols-2">
        <ProfileCard />
        <PasswordCard />
        <TwoFactorCard />
        <PasskeysCard />
        <div className="lg:col-span-2">
          <AppPasswordsCard />
        </div>
      </div>
    </>
  );
}
