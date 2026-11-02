import { createHmac } from 'node:crypto';

/**
 * What each internal secret is for. INTERNAL_API_TOKEN itself never leaves the
 * API: every component gets only the secrets for its own purposes, derived
 * from it, so a secret seen on the internal network (the mail-login bridge,
 * Postfix's internal submission ports) is good for that one purpose only.
 * The mail containers derive the same values (see their entrypoints).
 */
export type InternalSecretPurpose = 'mail-auth' | 'submission' | 'cyrus-smtp';

/** HMAC-SHA256(INTERNAL_API_TOKEN, "postarix:<purpose>"), hex. */
export function internalSecret(token: string, purpose: InternalSecretPurpose): string {
  return createHmac('sha256', token).update(`postarix:${purpose}`).digest('hex');
}
