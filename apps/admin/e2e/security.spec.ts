import { expect, test } from '@playwright/test';
import { API_PORT } from './env';

test('never forwards internal endpoints, whatever the spelling', async ({ request }) => {
  for (const path of [
    '/api/internal/mail-auth',
    '/api/INTERNAL/mail-auth',
    '/api//internal/mail-auth',
    '/api/%69nternal/mail-auth',
    '/api/internal',
    '/admin/../api/internal/mail-auth',
  ]) {
    const res = await request.post(path, {
      headers: { 'x-postarix-internal-token': 'e2e-internal-token-that-is-long-enough-for-real' },
      form: { username: 'a', password: 'b', service: 'imap' },
    });
    expect(res.status(), path).toBe(404);
  }
  // Control: sent straight to the API, the same request does reach the endpoint
  // (wrong mailbox credentials → 401), so the 404s above come from the rewrite.
  const direct = await request.post(`http://localhost:${API_PORT}/api/internal/mail-auth`, {
    headers: { 'x-postarix-internal-token': 'e2e-internal-token-that-is-long-enough-for-real' },
    form: { username: 'a@b.c', password: 'b', service: 'imap' },
  });
  expect(direct.status()).toBe(401);
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
