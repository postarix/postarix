'use client';

import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, Spinner, Table, Td, Th } from '@postarix/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import QRCode from 'qrcode';
import { type FormEvent, useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm';
import { CopyButton } from '@/components/copy-button';
import { PasswordInput } from '@/components/password-input';
import { api, errorMessage } from '@/lib/api';
import { authClient, useSession } from '@/lib/auth-client';
import { formatDate } from '@/lib/format';
import type { AppPassword } from '@/lib/types';

function ProfileCard() {
  const { data: session, refetch } = useSession();
  const [status, setStatus] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  if (!session) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setStatus(null);
    const { error } = await authClient.updateUser({ name: String(new FormData(event.currentTarget).get('name')).trim() });
    setPending(false);
    if (error) return setStatus({ tone: 'danger', text: error.message ?? 'Could not save' });
    await refetch();
    setStatus({ tone: 'success', text: 'Saved.' });
  }

  return (
    <Card>
      <CardHeader title="Profile" description={session.user.email} />
      <form onSubmit={submit} className="space-y-4 p-5">
        {status ? <Alert tone={status.tone}>{status.text}</Alert> : null}
        <Field label="Name">{(props) => <Input {...props} name="name" defaultValue={session.user.name} required maxLength={128} />}</Field>
        <Button type="submit" loading={pending}>
          Save
        </Button>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [status, setStatus] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setStatus(null);
    const { error } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
    setPending(false);
    if (error) return setStatus({ tone: 'danger', text: error.message ?? 'Could not change the password' });
    setCurrent('');
    setNext('');
    setStatus({ tone: 'success', text: 'Password changed. Other sessions were signed out.' });
  }

  return (
    <Card>
      <CardHeader title="Password" description="Also used by mail apps while two-factor authentication is off." />
      <form onSubmit={submit} className="space-y-4 p-5">
        {status ? <Alert tone={status.tone}>{status.text}</Alert> : null}
        <Field label="Current password">
          {(props) => (
            <Input {...props} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          )}
        </Field>
        <Field label="New password" hint="At least 12 characters.">
          {(props) => <PasswordInput {...props} value={next} onChange={setNext} required />}
        </Field>
        <Button type="submit" loading={pending}>
          Change password
        </Button>
      </form>
    </Card>
  );
}

function QrCode({ value }: { value: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    void QRCode.toDataURL(value, { margin: 1, width: 192 }).then(setSrc);
  }, [value]);
  return src ? (
    <img src={src} alt="QR code for your authenticator app" width={192} height={192} className="rounded-md bg-white p-1" />
  ) : (
    <Spinner />
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
    if (e) return setError(e.message ?? 'Could not disable two-factor authentication');
    await refetch();
    close();
  }

  const secret = setup ? (new URL(setup.totpURI).searchParams.get('secret') ?? '') : '';

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Two-factor authentication {enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
          </span>
        }
        description="With it on, mail apps need app passwords: your password alone can no longer read your mail."
        bordered={false}
        actions={
          enabled ? (
            <Button variant="secondary" onClick={() => setStep('disable')}>
              Turn off
            </Button>
          ) : (
            <Button onClick={() => setStep('password')}>
              <ShieldCheck className="size-4" aria-hidden />
              Turn on
            </Button>
          )
        }
      />
      <Dialog open={step === 'password' || step === 'disable'} onClose={close} title={step === 'disable' ? 'Turn off two-factor authentication' : 'Confirm your password'}>
        <form onSubmit={step === 'disable' ? disable : start} className="space-y-4">
          {error ? <Alert>{error}</Alert> : null}
          <Field label="Password">
            {(props) => (
              <Input {...props} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
            )}
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant={step === 'disable' ? 'danger' : 'primary'} loading={pending}>
              {step === 'disable' ? 'Turn off' : 'Continue'}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={step === 'scan'} onClose={close} title="Set up your authenticator app">
        {setup ? (
          <form onSubmit={confirm} className="space-y-4">
            {error ? <Alert>{error}</Alert> : null}
            <div className="flex flex-col items-center gap-2">
              <QrCode value={setup.totpURI} />
              <code className="break-all text-center text-xs text-ink-muted">{secret}</code>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Backup codes</p>
              <p className="mb-2 text-sm text-ink-muted">Each works once if you lose your device. Store them somewhere safe.</p>
              <div className="grid grid-cols-2 gap-1 rounded-md bg-surface-muted p-3 font-mono text-sm">
                {setup.backupCodes.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
              <div className="mt-2">
                <CopyButton value={setup.backupCodes.join('\n')} label="Copy codes" />
              </div>
            </div>
            <Field label="Code from the app">
              {(props) => (
                <Input {...props} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required />
              )}
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" loading={pending}>
                Turn on
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>
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
      <CardHeader
        title="Passkeys"
        description="Sign in with your fingerprint, face or a security key instead of a password."
        actions={
          <Button
            variant="secondary"
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
            <Fingerprint className="size-4" aria-hidden />
            Add passkey
          </Button>
        }
      />
      <div className="p-5">
        {error ? (
          <div className="mb-3">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        {passkeys.isLoading ? (
          <Spinner />
        ) : passkeys.data?.length ? (
          <ul className="divide-y divide-border">
            {passkeys.data.map((p) => (
              <li key={p.id} className="flex items-center justify-between py-2">
                <div>
                  <p className="text-sm font-medium">{p.name || 'Passkey'}</p>
                  <p className="text-xs text-ink-muted">Added {formatDate(new Date(p.createdAt).toISOString())}</p>
                </div>
                <Button size="sm" variant="ghost" aria-label={`Remove passkey ${p.name ?? ''}`} onClick={() => setRemoving(p)}>
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">No passkeys yet.</p>
        )}
      </div>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove this passkey?"
        description="You will no longer be able to sign in with it."
        confirmLabel="Remove"
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
      <CardHeader
        title="App passwords"
        description="One per mail app or device, so you can revoke a lost phone without changing your password."
        actions={
          <Button variant="secondary" onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden />
            New app password
          </Button>
        }
      />
      <div className="overflow-x-auto p-5">
        {list.isLoading ? (
          <Spinner />
        ) : list.error ? (
          <Alert>{errorMessage(list.error)}</Alert>
        ) : list.data?.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Access</Th>
                <Th>Last used</Th>
                <Th className="text-right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id}>
                  <Td className="font-medium">{p.name}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {p.scopes.map((s) => (
                        <Badge key={s}>{scopeLabel[s]}</Badge>
                      ))}
                    </div>
                  </Td>
                  <Td className="text-sm text-ink-muted">{p.lastUsedAt ? formatDate(p.lastUsedAt) : 'Never'}</Td>
                  <Td>
                    <div className="flex justify-end">
                      <Button size="sm" variant="ghost" aria-label={`Revoke ${p.name}`} onClick={() => setRevoking(p)}>
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No app passwords" description="Create one for each mail, calendar or contacts app you use." />
        )}
      </div>
      <Dialog open={creating} onClose={closeCreate} title={created ? 'Your new app password' : 'New app password'}>
        {created ? (
          <div className="space-y-4">
            <Alert tone="warning">Copy it now: it is shown only once.</Alert>
            <div className="flex items-center justify-between gap-2 rounded-md bg-surface-muted p-3">
              <code className="font-mono text-base tracking-wider" data-testid="app-password">
                {created}
              </code>
              <CopyButton value={created} />
            </div>
            <p className="text-sm text-ink-muted">Use your full email address as the user name in your mail app.</p>
            <div className="flex justify-end">
              <Button onClick={closeCreate}>Done</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {error ? <Alert>{error}</Alert> : null}
            <Field label="Name" hint='For example "Thunderbird on my laptop".'>
              {(props) => <Input {...props} name="name" required maxLength={64} autoFocus />}
            </Field>
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium">Access</legend>
              {(Object.keys(scopeLabel) as (keyof typeof scopeLabel)[]).map((scope) => (
                <label key={scope} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="scopes" value={scope} defaultChecked={scope !== 'dav'} className="size-4 accent-[var(--color-accent)]" />
                  {scopeLabel[scope]}
                </label>
              ))}
            </fieldset>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={closeCreate}>
                Cancel
              </Button>
              <Button type="submit" loading={pending}>
                <KeyRound className="size-4" aria-hidden />
                Create
              </Button>
            </div>
          </form>
        )}
      </Dialog>
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`Revoke "${revoking?.name ?? ''}"?`}
        description="Apps using it stop working immediately."
        confirmLabel="Revoke"
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
      <PageHeader title="Your account" description="Sign-in security and access for mail apps." />
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
