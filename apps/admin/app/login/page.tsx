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
import { FormField } from '@/components/form-field';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { authClient } from '@/lib/auth-client';
import { ssoErrorMessage, startSso } from '@/lib/sso';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<'password' | '2fa'>(params.get('step') === '2fa' ? '2fa' : 'password');
  const [error, setError] = useState<string | null>(ssoErrorMessage(params.get('error')));
  const [pending, setPending] = useState(false);
  const [email, setEmail] = useState('');
  const [ssoPending, setSsoPending] = useState(false);

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
    <Card className="airmail-edge w-full max-w-sm gap-5 overflow-hidden pt-9 shadow-2xl">
      <CardHeader className="gap-3">
        <BrandMark className="size-12" />
        <div>
          <CardTitle className="text-3xl font-semibold">Postarix</CardTitle>
          <CardDescription className="mt-1">Sign in to manage domains, mailboxes and people.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {step === 'password' ? (
          <form onSubmit={signIn}>
            <FieldGroup>
              {error ? <Notice>{error}</Notice> : null}
              <FormField label="Email">
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
              <FormField label="Password">
                {(props) => <Input {...props} name="password" type="password" autoComplete="current-password" required />}
              </FormField>
              <LoadingButton type="submit" className="w-full" loading={pending}>
                Sign in
              </LoadingButton>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <Separator className="flex-1" />
                or
                <Separator className="flex-1" />
              </div>
              <Button type="button" variant="outline" className="w-full" onClick={signInWithPasskey}>
                <KeyRound aria-hidden />
                Sign in with a passkey
              </Button>
              <LoadingButton type="button" variant="outline" className="w-full" loading={ssoPending} onClick={signInWithSso}>
                <Building2 aria-hidden />
                Sign in with your company account
              </LoadingButton>
            </FieldGroup>
          </form>
        ) : (
          <form onSubmit={verifyCode}>
            <FieldGroup>
              {error ? <Notice>{error}</Notice> : null}
              <p className="text-sm text-muted-foreground">Enter the 6-digit code from your authenticator app.</p>
              <FormField label="Authentication code">
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
              <LoadingButton type="submit" className="w-full" loading={pending}>
                Verify
              </LoadingButton>
            </FieldGroup>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-sidebar p-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
