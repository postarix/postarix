'use client';

import { Alert, Button, Card, Field, Input } from '@postarix/ui';
import { KeyRound, Mail } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';
import { authClient } from '@/lib/auth-client';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<'password' | '2fa'>(params.get('step') === '2fa' ? '2fa' : 'password');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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

  return (
    <Card className="w-full max-w-sm p-7">
      <div className="mb-6 flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-lg bg-accent text-white">
          <Mail className="size-5" aria-hidden />
        </span>
        <div>
          <p className="text-base font-semibold">Postarix</p>
          <p className="text-xs text-ink-muted">Administration</p>
        </div>
      </div>

      {error ? (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      {step === 'password' ? (
        <form onSubmit={signIn} className="space-y-4">
          <Field label="Email">
            {(props) => <Input {...props} name="email" type="email" autoComplete="username" required autoFocus />}
          </Field>
          <Field label="Password">
            {(props) => <Input {...props} name="password" type="password" autoComplete="current-password" required />}
          </Field>
          <Button type="submit" className="w-full" loading={pending}>
            Sign in
          </Button>
          <Button type="button" variant="secondary" className="w-full" onClick={signInWithPasskey}>
            <KeyRound className="size-4" aria-hidden />
            Sign in with a passkey
          </Button>
        </form>
      ) : (
        <form onSubmit={verifyCode} className="space-y-4">
          <p className="text-sm text-ink-muted">Enter the 6-digit code from your authenticator app.</p>
          <Field label="Authentication code">
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
          </Field>
          <Button type="submit" className="w-full" loading={pending}>
            Verify
          </Button>
        </form>
      )}
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center p-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
