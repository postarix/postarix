import { expect, type Page, test } from '@playwright/test';
import { ApiClient, config, smtp, unique, waitForMessage } from '../src/support.js';

const PASSWORD = 'webmail browser password';

test.describe.configure({ mode: 'serial' });

let wendy = '';
let xavier = '';

test.beforeAll(async () => {
  const admin = new ApiClient();
  await admin.signIn(config.adminEmail, config.adminPassword);
  const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Browser', slug: unique('browser') });
  const domain = await admin.ok<{ id: string; name: string }>('POST', `/api/orgs/${org.id}/domains`, { name: `${unique('br')}.test` });
  await admin.ok('POST', `/api/orgs/${org.id}/domains/${domain.id}/verify`);
  const create = async (localPart: string) =>
    (await admin.ok<{ address: string }>('POST', `/api/orgs/${org.id}/mailboxes`, { domainId: domain.id, localPart, password: PASSWORD, displayName: localPart }))
      .address;
  wendy = await create('wendy');
  xavier = await create('xavier');
});

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible();
}

test('serves the app with a strict CSP', async ({ request }) => {
  const res = await request.get('/');
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect((await request.post('/api/internal/mail-auth', { form: { username: 'a', password: 'b', service: 'imap' } })).status()).toBe(404);
});

test('reads mail safely: sandboxed, scripts stripped, remote images blocked until asked', async ({ page }) => {
  const subject = unique('browser-inbox');
  await smtp(config.smtpPort).sendMail({
    from: 'Sender <sender@outside.example>',
    to: wendy,
    subject,
    text: 'Plain version',
    html: '<p id="greeting">Hello <b>Wendy</b></p><script>window.parent.document.title="pwned"</script><img src="https://images.example/pixel.png">',
  });
  await waitForMessage(wendy, PASSWORD, subject);

  await signIn(page, wendy);
  const item = page.getByRole('list', { name: 'Messages' }).getByRole('link', { name: new RegExp(subject) });
  await expect(item).toBeVisible();
  await item.click();

  await expect(page.getByRole('heading', { name: subject })).toBeVisible();
  const frame = page.frameLocator(`iframe[title="Message: ${subject}"]`);
  await expect(frame.locator('#greeting')).toHaveText('Hello Wendy');
  await expect(frame.locator('script')).toHaveCount(0);
  await expect(page.locator('iframe').first()).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  await expect(page.getByText(/Remote images are blocked/)).toBeVisible();
  expect(await page.title()).not.toBe('pwned');

  await page.getByRole('button', { name: 'Show images' }).click();
  await expect(frame.locator('img')).toHaveAttribute('src', /\/api\/mail\/image\?/);
});

test('finds mail by searching', async ({ page }) => {
  const subject = unique('needle');
  const word = `zebra${Date.now()}`;
  await smtp(config.smtpPort).sendMail({ from: 'sender@outside.example', to: wendy, subject, text: `A ${word} inside` });
  await waitForMessage(wendy, PASSWORD, subject);
  await signIn(page, wendy);
  await page.getByRole('searchbox', { name: 'Search mail' }).fill(word);
  await page.getByRole('searchbox', { name: 'Search mail' }).press('Enter');
  await expect(page.getByRole('list', { name: 'Messages' }).getByRole('link')).toHaveCount(1);
  await expect(page.getByRole('list', { name: 'Messages' }).getByText(subject)).toBeVisible();
});

test('composes and sends a message with an attachment', async ({ page }) => {
  const subject = unique('browser-send');
  await signIn(page, wendy);
  await page.getByRole('button', { name: 'Compose' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('To').fill(`Xavier <${xavier}>`);
  await dialog.getByLabel('Subject').fill(subject);
  await dialog.getByLabel('Message').fill('Hello from the browser.');
  await dialog.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('attached text') });
  await expect(dialog.getByRole('list', { name: 'Attachments' }).getByText('notes.txt')).toBeVisible();
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Message sent.' })).toBeVisible();

  const received = await waitForMessage(xavier, PASSWORD, subject);
  expect(received).toContain('Hello from the browser.');
  expect(received).toMatch(/filename="?notes\.txt/);

  // It is filed in Sent.
  await page.getByRole('navigation', { name: 'Folders' }).getByRole('link', { name: /Sent/ }).click();
  await expect(page.getByRole('list', { name: 'Messages' }).getByText(subject)).toBeVisible();
});
