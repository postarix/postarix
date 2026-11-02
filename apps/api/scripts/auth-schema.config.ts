// Used only by the Better Auth CLI to generate src/db/schema/auth.ts.
// Run: pnpm --filter @postarix/api auth:schema
import { createAuth } from '../src/auth/auth.js';
import type { Database } from '../src/db/client.js';

export const auth = createAuth({} as Database, {
  NODE_ENV: 'development',
  PORT: 3000,
  INTERNAL_TLS_PORT: 3443,
  DATABASE_URL: 'postgresql://localhost/postarix',
  AUTH_URL: 'http://localhost:3000',
  AUTH_SECRET: 'schema-generation-only-secret-not-used-anywhere',
  TRUSTED_ORIGINS: [],
  SSO_TRUSTED_ISSUERS: [],
  TRUSTED_PROXIES: [],
  ALLOW_SIGNUP: false,
  ALLOW_USER_CREATE_ORG: false,
  MAIL_ENGINE: 'memory',
  CYRUS_HOST: 'cyrus',
  CYRUS_PORT: 143,
  CYRUS_SECURITY: 'starttls',
  CYRUS_TLS_VERIFY: true,
  CYRUS_ADMIN_USER: 'cyrus',
  MAIL_UPLOAD_LIMIT: 52_428_800,
  SUBMISSION_HOST: 'postfix',
  SUBMISSION_PORT: 10587,
  DOMAIN_VERIFICATION: 'skip',
  DNS_SERVERS: [],
  MAIL_HOSTNAME: 'localhost',
  MTA_STS_MODE: 'testing',
});
