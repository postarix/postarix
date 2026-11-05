import { passkey } from '@better-auth/passkey';
import { sso } from '@better-auth/sso';
import { betterAuth } from 'better-auth';
import { eq } from 'drizzle-orm';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { type DisconnectReason, requestDisconnect } from '../mail-sessions/session-disconnects.js';
import { admin, organization, twoFactor } from 'better-auth/plugins';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema/index.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { type CounterStore, MemoryCounterStore } from '../core/counter-store.js';
import { mapOidcConfigSecret, openOidcConfig } from '../sso/sso-crypto.js';
import { resolveSsoUser } from './sso-resolver.js';
import { hasInstanceAdminRole } from './roles.js';
import { closedWhileImpersonating, IMPERSONATION_FACTOR, postarixImpersonation } from './impersonation.js';
import { FailureLimiter } from '../mail-auth/failure-limiter.js';
import { loadInstanceSettings, passwordProblem } from '../settings/instance-settings.js';
import { webSignIns } from '../metrics/metrics.js';

/** Header the API sets with the client IP resolved by Express (honours TRUSTED_PROXIES). */
export const CLIENT_IP_HEADER = 'x-postarix-client-ip';

export const AUTH_BASE_PATH = '/api/auth';

/** Better Auth routes where someone chooses a password. */
const PASSWORD_PATHS = new Set(['/sign-up/email', '/change-password', '/reset-password']);


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
function isSsoSignInPath(pathname: string): boolean {
  if (!pathname.startsWith(AUTH_BASE_PATH)) return false;
  return isOpenSsoEndpoint(pathname.slice(AUTH_BASE_PATH.length));
}

function isOpenSsoEndpoint(path: string): boolean {
  return (
    path === '/sign-in/sso' ||
    path === '/sso/callback' ||
    path.startsWith('/sso/callback/') ||
    // SAML: the identity provider posts its response here, and reads Postarix' metadata.
    path.startsWith('/sso/saml2/sp/acs/') ||
    path === '/sso/saml2/sp/metadata'
  );
}

type AdapterFactory = ReturnType<typeof drizzleAdapter>;

/**
 * SSO client secrets are stored encrypted (sso-crypto.ts). Better Auth's SSO
 * plugin reads providers through the database adapter, so the adapter opens
 * them on the way out; nothing else ever sees them decrypted.
 */
function withOpenedSsoSecrets(factory: AdapterFactory, secret: string): AdapterFactory {
  const open = <T>(model: string, row: T): T => {
    if (model !== 'ssoProvider' || !row || typeof row !== 'object') return row;
    const record = row as Record<string, unknown>;
    if (typeof record.oidcConfig !== 'string') return row;
    try {
      return { ...record, oidcConfig: openOidcConfig(record.oidcConfig, secret) } as T;
    } catch {
      // A secret that no longer opens (say, AUTH_SECRET changed) breaks this
      // one provider only: Better Auth may list every provider at sign-in.
      return { ...record, oidcConfig: mapOidcConfigSecret(record.oidcConfig, () => '') } as T;
    }
  };
  const wrap = (adapter: ReturnType<AdapterFactory>): ReturnType<AdapterFactory> => ({
    ...adapter,
    findOne: (async (args) => open(args.model, await adapter.findOne(args))) as typeof adapter.findOne,
    findMany: (async (args) => (await adapter.findMany(args)).map((row) => open(args.model, row))) as typeof adapter.findMany,
    ...(adapter.transaction
      ? { transaction: (callback) => adapter.transaction((tx) => callback(wrap(tx as ReturnType<AdapterFactory>))) }
      : {}),
  });
  return ((options: Parameters<AdapterFactory>[0]) => wrap(factory(options))) as AdapterFactory;
}

/** Sign-ins that prove more than a password. */
function strongSignInMethod(path: string): 'passkey' | 'two_factor' | 'sso' | null {
  if (path === '/passkey/verify-authentication') return 'passkey';
  if (path.startsWith('/two-factor/verify-')) return 'two_factor';
  if (path === '/sso/callback' || path.startsWith('/sso/callback/') || path.startsWith('/sso/saml2/sp/acs/')) return 'sso';
  return null;
}

function accountKey(email: unknown): string | null {
  return typeof email === 'string' && email.length <= 320 ? email.trim().toLowerCase() : null;
}

/** Disconnect reasons noted by "before" database hooks, for their "after" hooks. */
const pendingDisconnects = new WeakMap<object, DisconnectReason>();

export function createAuth(db: Database, env: Env, counters: CounterStore = new MemoryCounterStore()) {
  const localCounters = new MemoryCounterStore();
  // 10 failed sign-ins per account per 15 minutes, like mail logins.
  const signInFailures = new FailureLimiter(counters, 'web-sign-in', async () => {
    const { signIn } = await loadInstanceSettings(db);
    return { maxFailures: signIn.maxFailures, windowMs: signIn.lockMinutes * 60_000 };
  });
  const authUrl = new URL(env.AUTH_URL);

  return betterAuth({
    appName: 'Postarix',
    baseURL: env.AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.AUTH_SECRET,
    // Identity providers on a private network (SSO_TRUSTED_ISSUERS) must be
    // trusted by Better Auth to be contacted at sign-in, but only there: on any
    // other route they are not browser origins the API accepts.
    trustedOrigins: (request) =>
      request && isSsoSignInPath(new URL(request.url).pathname)
        ? [...env.TRUSTED_ORIGINS, ...env.SSO_TRUSTED_ISSUERS]
        : env.TRUSTED_ORIGINS,
    // Transactions are required by SSO user resolution (and keep multi-step writes atomic).
    database: withOpenedSsoSecrets(drizzleAdapter(db, { provider: 'pg', schema, transaction: true }), env.AUTH_SECRET),
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
      // Shared by every API instance (Valkey in production), checked and
      // counted in one atomic step.
      customStorage: {
        consume: async (key, rule) => {
          let allowed: boolean;
          try {
            allowed = await counters.tryAdd(`ratelimit:${key}`, 1, rule.max, rule.window * 1000);
          } catch {
            // Valkey unreachable: limit per instance rather than fail every sign-in.
            allowed = await localCounters.tryAdd(`ratelimit:${key}`, 1, rule.max, rule.window * 1000);
          }
          return { allowed, retryAfter: allowed ? null : rule.window };
        },
      },
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
    databaseHooks: {
      // Mail sessions are checked only at login: end the open ones when an
      // update takes access away (see requestDisconnect). "before" sees what
      // changes, "after" which account it was.
      user: {
        update: {
          before: async (data, context) => {
            if (context && (data.banned === true || data.twoFactorEnabled === true)) {
              pendingDisconnects.set(context, data.banned === true ? 'account_banned' : 'second_factor_added');
            }
          },
          after: async (updated, context) => {
            const reason = context ? pendingDisconnects.get(context) : undefined;
            if (reason) await requestDisconnect(db, { userIds: [updated.id] }, reason);
          },
        },
      },
      account: {
        update: {
          before: async (data, context) => {
            if (context && typeof data.password === 'string') pendingDisconnects.set(context, 'password_changed');
          },
          after: async (updated, context) => {
            const reason = context ? pendingDisconnects.get(context) : undefined;
            if (reason && updated.providerId === 'credential') await requestDisconnect(db, { userIds: [updated.userId] }, reason);
          },
        },
      },
      session: {
        create: {
          // Whatever the sign-in method: a mailbox that may not sign in (or is
          // on a disabled domain) gets no web session. Instance administrators
          // keep theirs, so nobody locks the instance out by mistake.
          before: async (newSession) => {
            const [row] = await db
              .select({ status: schema.mailboxes.status, domainStatus: schema.domains.status, role: schema.user.role })
              .from(schema.mailboxes)
              .innerJoin(schema.domains, eq(schema.domains.id, schema.mailboxes.domainId))
              .innerJoin(schema.user, eq(schema.user.id, schema.mailboxes.userId))
              .where(eq(schema.mailboxes.userId, newSession.userId))
              .limit(1);
            if (row && (row.status !== 'active' || row.domainStatus !== 'active') && !hasInstanceAdminRole(row.role)) {
              throw new APIError('FORBIDDEN', { message: 'This mailbox cannot sign in', code: 'MAILBOX_SIGN_IN_DISABLED' });
            }
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path.startsWith('/organization/') && !OPEN_ORGANIZATION_ENDPOINTS.has(ctx.path)) {
          throw new APIError('NOT_FOUND');
        }
        if ((ctx.path.startsWith('/sso/') || ctx.path === '/sign-in/sso') && !isOpenSsoEndpoint(ctx.path)) {
          throw new APIError('NOT_FOUND');
        }
        // "Sign in as" goes through our API (rules, reason, audit record):
        // Better Auth's own impersonation endpoint stays closed.
        if (ctx.path === '/admin/impersonate-user') throw new APIError('NOT_FOUND');
        // A "Sign in as" session never touches its account's security.
        if (closedWhileImpersonating(ctx.path)) {
          const current = await getSessionFromCtx(ctx).catch(() => null);
          if ((current?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy) {
            throw new APIError('FORBIDDEN', { message: 'Not available while signed in as someone else', code: 'IMPERSONATING' });
          }
        }
        // The instance's password policy, wherever a password is chosen.
        if (PASSWORD_PATHS.has(ctx.path)) {
          const body = (ctx.body ?? {}) as { password?: unknown; newPassword?: unknown };
          const chosen = ctx.path === '/sign-up/email' ? body.password : body.newPassword;
          if (typeof chosen === 'string') {
            const problem = passwordProblem(chosen, (await loadInstanceSettings(db)).passwords);
            if (problem) throw new APIError('BAD_REQUEST', { message: problem, code: 'PASSWORD_POLICY' });
          }
        }
        // Password guessing against one account from many addresses: the
        // per-address limit does not see it, this one does.
        if (ctx.path === '/sign-in/email') {
          const email = accountKey((ctx.body as { email?: unknown } | undefined)?.email);
          if (email && (await signInFailures.isBlocked(email))) {
            webSignIns.inc({ result: 'blocked' });
            throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many failed sign-ins for this account; try again in a few minutes' });
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-in/email') {
          const email = accountKey((ctx.body as { email?: unknown } | undefined)?.email);
          if (email) {
            if (ctx.context.returned instanceof APIError) {
              webSignIns.inc({ result: 'failure' });
              await signInFailures.recordFailure(email);
            } else {
              webSignIns.inc({ result: 'success' });
              await signInFailures.recordSuccess(email);
            }
          }
        }
        // With a passkey, the account password stops working for mail apps.
        if (ctx.path === '/passkey/verify-registration' && !(ctx.context.returned instanceof APIError)) {
          const current = await getSessionFromCtx(ctx).catch(() => null);
          if (current) await requestDisconnect(db, { userIds: [current.user.id] }, 'second_factor_added');
        }
        // Remember how strong a new session is (see SecondFactorPolicy).
        const method = strongSignInMethod(ctx.path);
        const created = ctx.context.newSession?.session.id;
        if (method && created) {
          await db.insert(schema.sessionFactors).values({ sessionId: created, method }).onConflictDoNothing();
        }
      }),
    },
    plugins: [
      admin(),
      postarixImpersonation(env.AUTH_SECRET, async (sessionId) => {
        // Opened by an administrator who proved a second factor (checked before).
        await db.insert(schema.sessionFactors).values({ sessionId, method: IMPERSONATION_FACTOR }).onConflictDoNothing();
      }),
      organization({
        allowUserToCreateOrganization: (user) =>
          env.ALLOW_USER_CREATE_ORG || hasInstanceAdminRole((user as { role?: string | null }).role),
        // No invitations: members are people with a mailbox in the organization,
        // added by its admins through our API, which tells them by mail.
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
        saml: {
          // Only answers to requests Postarix made, signed, on time.
          enableInResponseToValidation: true,
          allowIdpInitiated: false,
          requireTimestamps: true,
          clockSkew: 3 * 60 * 1000,
          algorithms: { onDeprecated: 'reject' },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
