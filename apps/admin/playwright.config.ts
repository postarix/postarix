import { defineConfig, devices } from '@playwright/test';
import { ADMIN_PORT, API_PORT, baseURL, superAdmin } from './e2e/env';

// End-to-end tests: the built admin app (standalone server) in front of the built API
// with the in-memory mail engine. Needs PostgreSQL: E2E_DATABASE_URL must point
// to a database whose name ends in "_test". Build both first:
//   pnpm --filter @postarix/api build
//   API_INTERNAL_URL=http://localhost:3100 pnpm --filter @postarix/admin build
const databaseUrl = process.env.E2E_DATABASE_URL ?? 'postgresql://postarix:postarix@127.0.0.1:5432/postarix_e2e_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) {
  throw new Error('E2E_DATABASE_URL must name a database ending in "_test"');
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL,
    // Better Auth checks the Origin of state-changing requests, also for API calls made by tests.
    extraHTTPHeaders: { origin: baseURL },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'sh e2e/start-api.sh',
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        PORT: String(API_PORT),
        DATABASE_URL: databaseUrl,
        // The browser reaches the API through the admin server (same origin).
        AUTH_URL: baseURL,
        AUTH_SECRET: 'e2e-auth-secret-that-is-long-enough-for-better-auth',
        TRUSTED_PROXIES: '127.0.0.1,::1',
        MAIL_ENGINE: 'memory',
        DOMAIN_VERIFICATION: 'skip',
        MAIL_HOSTNAME: 'mail.postarix.test',
        ADMIN_EMAIL: superAdmin.email,
        ADMIN_PASSWORD: superAdmin.password,
        ADMIN_NAME: 'Root',
      },
    },
    {
      command: 'sh e2e/start-admin.sh',
      url: `${baseURL}/admin/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { PORT: String(ADMIN_PORT), HOSTNAME: 'localhost' },
    },
  ],
});
