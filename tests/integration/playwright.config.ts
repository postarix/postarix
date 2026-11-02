import { defineConfig, devices } from '@playwright/test';

// Browser tests of the webmail against the full stack started by run.sh
// (docker/compose/test.yml publishes the webmail on port 3002).
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: process.env.WEBMAIL_URL ?? 'http://localhost:3002', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
