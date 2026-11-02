import { passkey } from '@better-auth/passkey';
import { hash, verify } from '@node-rs/argon2';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, organization, twoFactor } from 'better-auth/plugins';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema/index.js';

/** Header the API sets with the client IP resolved by Express (honours TRUSTED_PROXIES). */
export const CLIENT_IP_HEADER = 'x-postarix-client-ip';

export const AUTH_BASE_PATH = '/api/auth';

// OWASP-recommended argon2id parameters (19 MiB, 2 iterations, 1 lane).
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function createAuth(db: Database, env: Env) {
  const authUrl = new URL(env.AUTH_URL);

  return betterAuth({
    appName: 'Postarix',
    baseURL: env.AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.AUTH_SECRET,
    trustedOrigins: env.TRUSTED_ORIGINS,
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !env.ALLOW_SIGNUP,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      password: {
        hash: (password) => hash(password, ARGON2_OPTIONS),
        verify: ({ hash: stored, password }) => verify(stored, password),
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
    plugins: [
      admin(),
      organization({
        allowUserToCreateOrganization: (user) =>
          env.ALLOW_USER_CREATE_ORG || (user as { role?: string | null }).role === 'admin',
      }),
      twoFactor({ issuer: 'Postarix' }),
      passkey({
        rpID: authUrl.hostname,
        rpName: 'Postarix',
        origin: [env.AUTH_URL, ...env.TRUSTED_ORIGINS],
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
