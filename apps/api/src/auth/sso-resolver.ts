import type { SSOUserResolution, SSOUserResolutionInput } from '@better-auth/sso';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { externalIdentities, mailboxes, ssoProvider, user } from '../db/schema/index.js';
import { resolveExternalIdentity } from '../identities/resolve-identity.js';
import { hasInstanceAdminRole } from './roles.js';

/**
 * Decides who an identity asserted by an organization's identity provider may
 * sign in as. Runs on every SSO sign-in, so disabling or deleting a mailbox
 * stops SSO immediately.
 *
 * The rule: the person linked to the asserted identity (the provider's issuer
 * and the person's id there, see external identities), or else the owner of
 * the active mailbox whose address is the asserted email, in the organization
 * that owns the provider. An identity provider therefore never reaches
 * accounts of other organizations, and never an instance administrator
 * (whose password an organization cannot reset either).
 */
export async function resolveSsoUser(db: Database, input: SSOUserResolutionInput): Promise<SSOUserResolution> {
  const reject = (code: string, message: string): SSOUserResolution => ({ action: 'reject', code, message });
  const [provider] = await db
    .select({ organizationId: ssoProvider.organizationId, issuer: ssoProvider.issuer })
    .from(ssoProvider)
    .where(eq(ssoProvider.providerId, input.providerId))
    .limit(1);
  if (!provider?.organizationId) return reject('SSO_PROVIDER_UNAVAILABLE', 'This sign-in provider is not available');

  // A linked identity first: the provider may know the person by another email.
  // A link that no longer qualifies (mailbox disabled, instance administrator)
  // refuses the sign-in rather than falling back to the email.
  const issuer = input.accountKey.issuer || provider.issuer;
  const subject = input.accountKey.accountId;
  if (subject) {
    const [linked] = await db
      .select({ id: externalIdentities.id })
      .from(externalIdentities)
      .where(
        and(
          eq(externalIdentities.organizationId, provider.organizationId),
          eq(externalIdentities.issuer, issuer),
          eq(externalIdentities.subject, subject),
        ),
      )
      .limit(1);
    if (linked) {
      const person = await resolveExternalIdentity(db, provider.organizationId, issuer, subject);
      if (!person) return reject('NO_MAILBOX', 'There is no active mailbox for this account here');
      return { action: 'link', userId: person.userId, profile: 'preserve' };
    }
  }

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
