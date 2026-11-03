import { Alert, AlertDescription } from '@postarix/ui/components/alert';
import { Button } from '@postarix/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@postarix/ui/components/card';
import { Field, FieldGroup, FieldLabel, FieldSeparator } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { Spinner } from '@postarix/ui/components/spinner';
import { Postmark } from '@postarix/ui/components/postmark';
import { Building2, CircleAlert, KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { useBranding } from '@/lib/branding';
import { navigate } from '@/lib/router';
import { ssoErrorMessage, startSso } from '@/lib/sso';

export function LoginPage() {
  const branding = useBranding();
  const [step, setStep] = useState<'password' | '2fa'>('password');
  const [error, setError] = useState<string | null>(() => ssoErrorMessage(new URLSearchParams(window.location.search).get('error')));
  const [pending, setPending] = useState(false);
  const [email, setEmail] = useState('');
  const [ssoPending, setSsoPending] = useState(false);

  const done = () => navigate('/', true);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { data, error: e } = await authClient.signIn.email({ email: String(form.get('email')), password: String(form.get('password')) });
    setPending(false);
    if (e) return setError(e.message ?? 'Sign-in failed');
    if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) return setStep('2fa');
    done();
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code')).replace(/\s/g, '');
    setPending(true);
    setError(null);
    const { error: e } = await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (e) return setError(e.message ?? 'Invalid code');
    done();
  }

  async function passkey() {
    setError(null);
    const result = await authClient.signIn.passkey();
    if (result?.error) return setError(result.error.message ?? 'Passkey sign-in failed');
    done();
  }

  async function sso() {
    setError(null);
    if (!email.includes('@')) return setError('Enter your email address first.');
    setSsoPending(true);
    setError(await startSso(email, '/', '/login'));
    setSsoPending(false);
  }

  return (
    <main className="grid min-h-full place-items-center bg-sidebar bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgb(43_76_155/0.45),transparent)] p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <Postmark className="size-8" />
          <span className="text-lg font-semibold tracking-tight text-white">{branding?.productName ?? 'Postarix'}</span>
        </div>
      <Card className="gap-6 shadow-2xl ring-1 ring-black/10">
        <CardHeader className="text-center">
          <CardTitle className="text-xl font-semibold">{step === 'password' ? 'Welcome back' : 'Two-step verification'}</CardTitle>
          <CardDescription>{step === 'password' ? 'Sign in to your mailbox.' : 'One more step to keep your account safe.'}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={step === 'password' ? signIn : verify}>
            <FieldGroup>
              {error ? (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              {step === 'password' ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="email">Email</FieldLabel>
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      autoComplete="username"
                      required
                      autoFocus
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="password">Password</FieldLabel>
                    <Input id="password" name="password" type="password" autoComplete="current-password" required />
                  </Field>
                  <Button type="submit" disabled={pending}>
                    {pending ? <Spinner /> : null}
                    Sign in
                  </Button>
                  <FieldSeparator>or</FieldSeparator>
                  <Button type="button" variant="outline" onClick={() => void passkey()}>
                    <KeyRound aria-hidden />
                    Sign in with a passkey
                  </Button>
                  <Button type="button" variant="outline" disabled={ssoPending} onClick={() => void sso()}>
                    {ssoPending ? <Spinner /> : <Building2 aria-hidden />}
                    Sign in with your company account
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">Enter the 6-digit code from your authenticator app.</p>
                  <Field>
                    <FieldLabel htmlFor="code">Authentication code</FieldLabel>
                    <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus />
                  </Field>
                  <Button type="submit" disabled={pending}>
                    {pending ? <Spinner /> : null}
                    Verify
                  </Button>
                </>
              )}
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
        <p className="mt-6 text-center text-xs text-sidebar-muted">Mail apps sign in with an app password from your account settings.</p>
        {branding?.loginMessage ? (
          <p className="mt-3 text-center text-xs whitespace-pre-line text-sidebar-muted">{branding.loginMessage}</p>
        ) : null}
      </div>
    </main>
  );
}
