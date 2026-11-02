import { createHmac } from 'node:crypto';

/**
 * What each internal secret is for. Every component gets only the secrets for
 * its own purposes (POSTARIX_SECRET_<PURPOSE>), so a secret seen on the
 * internal network (the mail-login bridge, Postfix's internal submission
 * ports) is good for that one purpose only, and INTERNAL_API_TOKEN never
 * leaves the API. Installations that only set INTERNAL_API_TOKEN derive them
 * from it (deploy/scripts/derive-secrets.sh writes the same values).
 */
export type InternalSecretPurpose = 'mail-auth' | 'submission' | 'cyrus-smtp';

/** HMAC-SHA256(INTERNAL_API_TOKEN, "postarix:<purpose>"), hex. */
export function internalSecret(token: string, purpose: InternalSecretPurpose): string {
  return createHmac('sha256', token).update(`postarix:${purpose}`).digest('hex');
}

/** The secret for a purpose: set explicitly, or derived from INTERNAL_API_TOKEN. */
export function secretFor(
  env: { INTERNAL_API_TOKEN?: string | undefined; POSTARIX_SECRET_MAIL_AUTH?: string | undefined; POSTARIX_SECRET_SUBMISSION?: string | undefined },
  purpose: 'mail-auth' | 'submission',
): string | null {
  const explicit = purpose === 'mail-auth' ? env.POSTARIX_SECRET_MAIL_AUTH : env.POSTARIX_SECRET_SUBMISSION;
  if (explicit) return explicit;
  return env.INTERNAL_API_TOKEN ? internalSecret(env.INTERNAL_API_TOKEN, purpose) : null;
}
