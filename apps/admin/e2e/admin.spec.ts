import { expect, test } from '@playwright/test';
import { MAILBOX_PASSWORD, superAdmin } from './env';
import { signIn, unique } from './support';

// One organization walked through end to end, in order.
test.describe.configure({ mode: 'serial' });

const orgName = unique('Acme');
const domain = `${unique('acme')}.test`;
let orgPath = '';

test.beforeEach(async ({ page }) => {
  await signIn(page, superAdmin.email, superAdmin.password);
});

test('creates an organization', async ({ page }) => {
  await page.getByRole('button', { name: 'New organization' }).first().click();
  await page.getByLabel('Name').fill(orgName);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: orgName })).toBeVisible();
  orgPath = new URL(page.url()).pathname;
  expect(orgPath).toMatch(/^\/admin\/o\/[\w-]+$/);
});

test('adds and verifies a domain, and shows its DNS records', async ({ page }) => {
  await page.goto(`${orgPath}/domains`);
  await page.getByRole('button', { name: 'Add domain' }).first().click();
  await page.getByLabel('Domain name').fill(domain);
  await page.getByRole('dialog').getByRole('button', { name: 'Add domain' }).click();

  const card = page.getByTestId(`domain-${domain}`);
  await expect(card.getByText('Pending verification')).toBeVisible();
  await expect(card.getByText(/postarix-verification=/).first()).toBeVisible();
  await card.getByRole('button', { name: 'Verify' }).click();
  await expect(card.getByText('Verified', { exact: true })).toBeVisible();

  // Still expanded from the pending state; now including the DKIM record.
  await expect(card.getByRole('button', { name: 'Hide DNS records' })).toBeVisible();
  await expect(card.getByRole('cell', { name: 'DKIM', exact: true })).toBeVisible();
  await expect(card.getByText(/v=DKIM1/)).toBeVisible();
  // The test domain does not exist in DNS, so the live check reports records as missing.
  await expect(card.getByRole('row', { name: /DKIM/ }).getByText(/Missing|Could not check/)).toBeVisible();
});

test('creates, edits and resets a mailbox', async ({ page }) => {
  await page.goto(`${orgPath}/mailboxes`);
  await page.getByRole('button', { name: 'New mailbox' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Address').fill('jane');
  await dialog.getByLabel('Display name').fill('Jane Doe');
  await dialog.getByLabel('Password', { exact: true }).fill(MAILBOX_PASSWORD);
  await dialog.getByLabel('Quota (GB)').fill('2');
  await dialog.getByRole('button', { name: 'Create mailbox' }).click();

  const row = page.getByRole('row', { name: new RegExp(`jane@${domain}`) });
  await expect(row).toBeVisible();
  await expect(row.getByText('Jane Doe')).toBeVisible();
  await expect(row.getByText(/0 B \/ 2 GB/)).toBeVisible();

  await row.getByRole('button', { name: `Edit jane@${domain}` }).click();
  await page.getByRole('dialog').getByLabel('Quota (GB)').fill('5');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(row.getByText(/\/ 5 GB/)).toBeVisible();

  await row.getByRole('button', { name: `Reset password for jane@${domain}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Generate password' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByText('Password changed.')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
});

test('refuses weak mailbox passwords with a readable error', async ({ page }) => {
  await page.goto(`${orgPath}/mailboxes`);
  await page.getByRole('button', { name: 'New mailbox' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Address').fill('weak');
  await dialog.getByLabel('Password', { exact: true }).evaluate((el: HTMLInputElement) => el.removeAttribute('minlength'));
  await dialog.getByLabel('Password', { exact: true }).fill('short');
  await dialog.getByRole('button', { name: 'Create mailbox' }).click();
  await expect(dialog.getByRole('alert')).toContainText(/password/i);
});

test('creates an alias', async ({ page }) => {
  await page.goto(`${orgPath}/aliases`);
  await page.getByRole('button', { name: 'New alias' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Address').fill('sales');
  await dialog.getByLabel('Deliver to').fill(`jane@${domain}\nboss@outside.example`);
  await dialog.getByRole('button', { name: 'Create alias' }).click();
  const row = page.getByRole('row', { name: new RegExp(`sales@${domain}`) });
  await expect(row.getByText('boss@outside.example')).toBeVisible();
});

test('lists the mailbox owner as a member and promotes them', async ({ page }) => {
  await page.goto(`${orgPath}/members`);
  // Every mailbox owner is a member of its organization.
  const row = page.getByRole('row', { name: new RegExp(`jane@${domain}`) });
  await expect(row).toBeVisible();
  await row.getByLabel(`Role of jane@${domain}`).selectOption('admin');
  await page.reload();
  await expect(page.getByRole('row', { name: new RegExp(`jane@${domain}`) }).getByLabel(`Role of jane@${domain}`)).toHaveValue('admin');
});

test('records every change in the activity log', async ({ page }) => {
  await page.goto(`${orgPath}/activity`);
  for (const action of ['Domain created', 'Domain verified', 'Mailbox created', 'Mailbox password reset', 'Alias created', 'Member role changed']) {
    await expect(page.getByRole('cell', { name: action }).first()).toBeVisible();
  }
  await expect(page.getByRole('cell', { name: superAdmin.email }).first()).toBeVisible();
});

test('deletes the organization only after its name is typed', async ({ page }) => {
  await page.goto(orgPath);
  await page.getByRole('button', { name: 'Delete organization' }).click();
  const dialog = page.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: 'Delete organization' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(`Type “${orgName}” to confirm`).fill(orgName.toLowerCase());
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(`Type “${orgName}” to confirm`).fill(orgName);
  await confirm.click();
  await expect(page).toHaveURL(/\/admin\/?$/);
  await expect(page.getByText(orgName)).toHaveCount(0);
});
