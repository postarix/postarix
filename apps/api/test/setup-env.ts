import { testDatabaseUrl } from './test-env.js';

// Runs in every test worker before any test file is loaded.
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: testDatabaseUrl(),
  AUTH_URL: 'http://localhost:3000',
  AUTH_SECRET: 'test-secret-that-is-long-enough-for-better-auth',
  TRUSTED_ORIGINS: '',
  TRUSTED_PROXIES: '',
  ALLOW_SIGNUP: 'true',
  ALLOW_USER_CREATE_ORG: 'true',
  MAIL_ENGINE: 'memory',
  DOMAIN_VERIFICATION: 'skip',
  INTERNAL_API_TOKEN: 'internal-test-token-that-is-long-enough',
  MAIL_HOSTNAME: 'mail.example.test',
});
