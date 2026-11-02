import { expect, test } from '@playwright/test';
import { MAILBOX_PASSWORD, superAdmin } from './env';
import { signIn, unique } from './support';

test.describe.configure({ mode: 'serial' });

// A plain member: their own account page works, organization admin pages don't.
const domain = `${unique('member')}.test`;
const address = `max@${domain}`;
let orgId = '';
let otherOrgId = '';

test.beforeAll(async ({ request }) => {
  const login = await request.post('/api/auth/sign-in/email', {
    data: { email: superAdmin.email, password: superAdmin.password },
  });
  expect(login.ok()).toBe(true);
  const create = async (name: string) => {
    const res = await request.post('/api/auth/organization/create', {
      data: { name, slug: unique(name.toLowerCase()), keepCurrentActiveOrganization: true },
    });
    expect(res.ok()).toBe(true);
    return ((await res.json()) as { id: string }).id;
  };
  orgId = await create('Members');
  otherOrgId = await create('Elsewhere');
  const d = await request.post(`/api/orgs/${orgId}/domains`, { data: { name: domain } });
  const { id: domainId } = (await d.json()) as { id: string };
  await request.post(`/api/orgs/${orgId}/domains/${domainId}/verify`);
  const mb = await request.post(`/api/orgs/${orgId}/mailboxes`, {
    data: { domainId, localPart: 'max', password: MAILBOX_PASSWORD },
  });
  // Creating the mailbox makes its owner a plain member of the organization.
  expect(mb.status()).toBe(201);
});

test('sees only the overview of their organization', async ({ page }) => {
  await signIn(page, address, MAILBOX_PASSWORD);
  await page.goto(`/admin/o/${orgId}`);
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Organization sections' });
  await expect(tabs.getByRole('link')).toHaveText(['Overview']);

  await page.goto(`/admin/o/${orgId}/mailboxes`);
  await expect(page.getByText(/forbidden/i)).toBeVisible();
});

test('cannot open another organization', async ({ page }) => {
  await signIn(page, address, MAILBOX_PASSWORD);
  await page.goto(`/admin/o/${otherOrgId}`);
  await expect(page.getByText(/not found/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Elsewhere' })).toHaveCount(0);
});

test('creates and revokes an app password', async ({ page }) => {
  await signIn(page, address, MAILBOX_PASSWORD);
  await page.goto('/admin/account');
  await page.getByRole('button', { name: 'New app password' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Thunderbird');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('app-password')).toHaveText(/^(\S{4} ){5}\S{4}$/);
  await page.getByRole('button', { name: 'Done' }).click();

  const row = page.getByRole('row', { name: /Thunderbird/ });
  await expect(row.getByText('Never')).toBeVisible();
  await row.getByRole('button', { name: 'Revoke Thunderbird' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByRole('row', { name: /Thunderbird/ })).toHaveCount(0);
});
