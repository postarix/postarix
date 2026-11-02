/** Messages for the error codes the API redirects back with after a failed SSO sign-in. */
const SSO_ERRORS: Record<string, string> = {
  NO_MAILBOX: 'Your company account has no active mailbox here. Ask your administrator.',
  SSO_PROVIDER_UNAVAILABLE: 'Single sign-on is not available for this domain.',
};

export function ssoErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return SSO_ERRORS[code] ?? 'Signing in with your company account did not work. Try again or use your password.';
}

/**
 * Starts single sign-on for the domain of the given address. Resolves only on
 * failure: on success the browser leaves for the identity provider.
 */
export async function startSso(email: string, returnPath: string, errorPath: string): Promise<string> {
  const origin = window.location.origin;
  const response = await fetch('/api/auth/sign-in/sso', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      loginHint: email,
      callbackURL: `${origin}${returnPath}`,
      errorCallbackURL: `${origin}${errorPath}`,
    }),
  });
  const data = (await response.json().catch(() => ({}))) as { url?: string; message?: string };
  if (response.ok && data.url) {
    window.location.assign(data.url);
    return new Promise(() => {});
  }
  return response.status === 404 || response.status === 400
    ? 'Single sign-on is not set up for this domain. Sign in with your password.'
    : (data.message ?? 'Single sign-on is unavailable right now.');
}
