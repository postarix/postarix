import type { SSOUserResolution, SSOUserResolutionInput } from '@better-auth/sso';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { mailboxes, ssoProvider, user } from '../db/schema/index.js';
import { hasInstanceAdminRole } from './roles.js';

/**
 * Decides who an identity asserted by an organization's identity provider may
 * sign in as. Runs on every SSO sign-in, so disabling or deleting a mailbox
 * stops SSO immediately.
 *
 * The rule: the asserted email must be an active mailbox of the organization
 * that owns the provider. An identity provider therefore never reaches
 * accounts of other organizations, and never an instance administrator
 * (whose password an organization cannot reset either).
 */
export async function resolveSsoUser(db: Database, input: SSOUserResolutionInput): Promise<SSOUserResolution> {
  const reject = (code: string, message: string): SSOUserResolution => ({ action: 'reject', code, message });
  const [provider] = await db
    .select({ organizationId: ssoProvider.organizationId })
    .from(ssoProvider)
    .where(eq(ssoProvider.providerId, input.providerId))
    .limit(1);
  if (!provider?.organizationId) return reject('SSO_PROVIDER_UNAVAILABLE', 'This sign-in provider is not available');

  const email = input.providerUser.email.trim().toLowerCase();
  const [match] = await db
    .select({ userId: user.id, role: user.role, status: mailboxes.status })
    .from(mailboxes)
    .innerJoin(user, eq(user.id, mailboxes.userId))
    .where(and(eq(mailboxes.address, email), eq(mailboxes.organizationId, provider.organizationId)))
    .limit(1);
  if (!match || match.status !== 'active' || hasInstanceAdminRole(match.role)) {
    return reject('NO_MAILBOX', 'There is no active mailbox for this account here');
  }
  return { action: 'link', userId: match.userId, profile: 'preserve' };
}
