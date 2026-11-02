import { expect, test } from '@playwright/test';

test('never forwards internal endpoints, whatever the spelling', async ({ request }) => {
  for (const path of ['/api/internal/mail-auth', '/api/INTERNAL/mail-auth', '/api//internal/mail-auth', '/api/internal']) {
    const res = await request.post(path, { form: { username: 'a', password: 'b', service: 'imap' } });
    expect(res.status(), path).toBe(404);
  }
});

test('serves pages with a nonce-based CSP and anti-framing headers', async ({ request }) => {
  const res = await request.get('/admin/login');
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(res.headers()['x-frame-options']).toBe('DENY');
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
});

test('sends signed-out visitors to the login page', async ({ page }) => {
  await page.goto('/admin/o/some-org/mailboxes');
  await expect(page).toHaveURL(/\/admin\/login/);
});
