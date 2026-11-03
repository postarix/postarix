'use client';

import { Button } from '@postarix/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@postarix/ui/components/card';
import { FieldGroup } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { Separator } from '@postarix/ui/components/separator';
import { Building2, KeyRound } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';
import { BrandMark } from '@/components/brand';
import { useBranding } from '@/lib/queries';
import { FormField } from '@/components/form-field';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { authClient } from '@/lib/auth-client';
import { ssoErrorMessage, startSso } from '@/lib/sso';
import { t } from '@/lib/i18n';

function LoginForm() {
  const branding = useBranding();
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<'password' | '2fa'>(params.get('step') === '2fa' ? '2fa' : 'password');
  const [error, setError] = useState<string | null>(ssoErrorMessage(params.get('error')));
  const [pending, setPending] = useState(false);
  const [email, setEmail] = useState('');
  const [ssoPending, setSsoPending] = useState(false);
  // System → Customize can leave only single sign-on here; ?password=1 still shows the form.
  const passwordForm = !branding.data?.hidePasswordSignIn || params.get('password') === '1';

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { data, error: signInError } = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
    });
    setPending(false);
    if (signInError) return setError(signInError.message ?? 'Sign-in failed');
    if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) return setStep('2fa');
    router.replace('/');
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error: verifyError } = await authClient.twoFactor.verifyTotp({
      code: String(form.get('code')).replace(/\s/g, ''),
    });
    setPending(false);
    if (verifyError) return setError(verifyError.message ?? 'Invalid code');
    router.replace('/');
  }

  async function signInWithPasskey() {
    setError(null);
    const result = await authClient.signIn.passkey();
    if (result?.error) return setError(result.error.message ?? 'Passkey sign-in failed');
    router.replace('/');
  }

  async function signInWithSso() {
    setError(null);
    if (!email.includes('@')) return setError('Enter your email address first.');
    setSsoPending(true);
    setError(await startSso(email, '/admin', '/admin/login'));
    setSsoPending(false);
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-6 flex items-center justify-center gap-2.5">
        <BrandMark className="size-8" logo={branding.data?.logo} />
        <span className="text-lg font-semibold tracking-tight text-white">{branding.data?.productName ?? 'Postarix'}</span>
      </div>
    <Card className="gap-6 shadow-2xl ring-1 ring-black/10">
      <CardHeader className="text-center">
        <CardTitle className="text-xl font-semibold">{step === 'password' ? 'Administration' : 'Two-step verification'}</CardTitle>
        <CardDescription>{step === 'password' ? 'Sign in to manage domains, mailboxes and people.' : 'One more step to keep your account safe.'}</CardDescription>
      </CardHeader>
      <CardContent>
        {step === 'password' ? (
          <form
            onSubmit={(event) => {
              if (passwordForm) return void signIn(event);
              event.preventDefault();
              void signInWithSso();
            }}
          >
            <FieldGroup>
              {error ? <Notice>{error}</Notice> : null}
              <FormField label={t('Email')}>
                {(props) => (
                  <Input
                    {...props}
                    name="email"
                    type="email"
                    autoComplete="username"
                    required
                    autoFocus
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                )}
              </FormField>
              {passwordForm ? (
                <>
                  <FormField label={t('Password')}>
                    {(props) => <Input {...props} name="password" type="password" autoComplete="current-password" required />}
                  </FormField>
                  <LoadingButton type="submit" className="w-full" loading={pending}>{t('Sign in')}</LoadingButton>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <Separator className="flex-1" />{t('or')}<Separator className="flex-1" />
                  </div>
                </>
              ) : null}
              {passwordForm ? null : (
                <LoadingButton type="submit" className="w-full" loading={ssoPending}>
                  <Building2 aria-hidden />{t('Sign in with your company account')}</LoadingButton>
              )}
              <Button type="button" variant="outline" className="w-full" onClick={signInWithPasskey}>
                <KeyRound aria-hidden />{t('Sign in with a passkey')}</Button>
              {passwordForm ? (
                <LoadingButton type="button" variant="outline" className="w-full" loading={ssoPending} onClick={signInWithSso}>
                  <Building2 aria-hidden />{t('Sign in with your company account')}</LoadingButton>
              ) : (
                <a href="?password=1" className="text-center text-xs text-muted-foreground underline-offset-4 hover:underline">
                  {t('Sign in with a password')}
                </a>
              )}
            </FieldGroup>
          </form>
        ) : (
          <form onSubmit={verifyCode}>
            <FieldGroup>
              {error ? <Notice>{error}</Notice> : null}
              <p className="text-sm text-muted-foreground">{t('Enter the 6-digit code from your authenticator app.')}</p>
              <FormField label={t('Authentication code')}>
                {(props) => (
                  <Input
                    {...props}
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9 ]{6,7}"
                    required
                    autoFocus
                  />
                )}
              </FormField>
              <LoadingButton type="submit" className="w-full" loading={pending}>{t('Verify')}</LoadingButton>
            </FieldGroup>
          </form>
        )}
      </CardContent>
    </Card>
      {branding.data?.loginMessage ? (
        <p className="mt-6 text-center text-xs whitespace-pre-line text-sidebar-muted">{branding.data.loginMessage}</p>
      ) : null}
      {branding.data?.footer ? (
        <p className="mt-4 text-center text-[0.7rem] whitespace-pre-line text-sidebar-muted/80">{branding.data.footer}</p>
      ) : null}
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-sidebar bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgb(43_76_155/0.45),transparent)] p-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
