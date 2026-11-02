import { Alert, AlertDescription } from '@postarix/ui/components/alert';
import { Button } from '@postarix/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@postarix/ui/components/card';
import { Field, FieldGroup, FieldLabel } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { Spinner } from '@postarix/ui/components/spinner';
import { CircleAlert, KeyRound, Mail } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { navigate } from '@/lib/router';

export function LoginPage() {
  const [step, setStep] = useState<'password' | '2fa'>('password');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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

  return (
    <main className="grid min-h-full place-items-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Mail className="size-5" aria-hidden />
            </span>
            <div>
              <CardTitle>Postarix Mail</CardTitle>
              <CardDescription>Sign in to your mailbox</CardDescription>
            </div>
          </div>
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
                    <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="password">Password</FieldLabel>
                    <Input id="password" name="password" type="password" autoComplete="current-password" required />
                  </Field>
                  <Button type="submit" disabled={pending}>
                    {pending ? <Spinner /> : null}
                    Sign in
                  </Button>
                  <Button type="button" variant="outline" onClick={() => void passkey()}>
                    <KeyRound aria-hidden />
                    Sign in with a passkey
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
    </main>
  );
}
