import { passkey } from '@better-auth/passkey';
import { sso } from '@better-auth/sso';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { admin, organization, twoFactor } from 'better-auth/plugins';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema/index.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { resolveSsoUser } from './sso-resolver.js';
import { hasInstanceAdminRole } from './roles.js';

/** Header the API sets with the client IP resolved by Express (honours TRUSTED_PROXIES). */
export const CLIENT_IP_HEADER = 'x-postarix-client-ip';

export const AUTH_BASE_PATH = '/api/auth';

/**
 * Better Auth's organization endpoints that stay open. Everything else under
 * /organization/ (members, roles, invitations, renaming, listing members…) goes
 * through our own API instead, which applies our rules (owner-only grants, never
 * zero owners, admin-only listings) and writes the audit log.
 */
const OPEN_ORGANIZATION_ENDPOINTS = new Set(['/organization/create']);

/**
 * Single sign-on: only signing in stays open. Providers are managed through
 * our organization-scoped API (`orgs/:orgId/sso`), which ties each one to a
 * verified domain of the organization and writes the audit log.
 */
function isOpenSsoEndpoint(path: string): boolean {
  return path === '/sign-in/sso' || path === '/sso/callback' || path.startsWith('/sso/callback/');
}

export function createAuth(db: Database, env: Env) {
  const authUrl = new URL(env.AUTH_URL);

  return betterAuth({
    appName: 'Postarix',
    baseURL: env.AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.AUTH_SECRET,
    trustedOrigins: env.TRUSTED_ORIGINS,
    // Transactions are required by SSO user resolution (and keep multi-step writes atomic).
    database: drizzleAdapter(db, { provider: 'pg', schema, transaction: true }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !env.ALLOW_SIGNUP,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      password: {
        hash: hashPassword,
        verify: ({ hash: stored, password }) => verifyPassword(stored, password),
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: env.NODE_ENV !== 'test',
      window: 60,
      max: 100,
    },
    advanced: {
      // Explicit: Better Auth otherwise disables its origin/CSRF check whenever it
      // detects a test environment (NODE_ENV=test or a truthy TEST variable).
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: authUrl.protocol === 'https:',
      ipAddress: {
        // Only trust the header our own middleware writes from Express' req.ip.
        ipAddressHeaders: [CLIENT_IP_HEADER],
      },
      database: {
        generateId: () => crypto.randomUUID(),
      },
    },
    telemetry: { enabled: false },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path.startsWith('/organization/') && !OPEN_ORGANIZATION_ENDPOINTS.has(ctx.path)) {
          throw new APIError('NOT_FOUND');
        }
        if ((ctx.path.startsWith('/sso/') || ctx.path === '/sign-in/sso') && !isOpenSsoEndpoint(ctx.path)) {
          throw new APIError('NOT_FOUND');
        }
      }),
    },
    plugins: [
      admin(),
      organization({
        allowUserToCreateOrganization: (user) =>
          env.ALLOW_USER_CREATE_ORG || hasInstanceAdminRole((user as { role?: string | null }).role),
        // Accepting an invitation requires a verified email. Email delivery arrives in
        // Phase 1; until then members are added by admins (auth.api.addMember).
        // Deleting an organization must deprovision its mailboxes (Cyrus), DKIM keys
        // (Valkey) and accounts first; Better Auth's endpoint would only drop rows.
        disableOrganizationDeletion: true,
      }),
      twoFactor({ issuer: 'Postarix' }),
      passkey({
        rpID: authUrl.hostname,
        rpName: 'Postarix',
        origin: [env.AUTH_URL, ...env.TRUSTED_ORIGINS],
      }),
      sso({
        // Accounts are mailboxes: SSO never creates one, it only signs in the
        // owner of an existing mailbox of the provider's organization.
        disableImplicitSignUp: true,
        organizationProvisioning: { disabled: true },
        // Registration through Better Auth's endpoint is closed (see the hook above).
        providersLimit: 0,
        resolveUser: (input) => resolveSsoUser(db, input),
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
