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
  await row.getByLabel(`Role of jane@${domain}`).click();
  await page.getByRole('option', { name: 'Admin' }).click();
  await expect(page.getByText(/role changed|saved/i).or(page.getByRole('row', { name: new RegExp(`jane@${domain}`) }))).toBeVisible();
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByRole('row', { name: new RegExp(`jane@${domain}`) }).getByLabel(`Role of jane@${domain}`)).toHaveText('Admin');
});

test('records every change in the activity log', async ({ page }) => {
  await page.goto(`${orgPath}/activity`);
  for (const action of ['Domain created', 'Domain verified', 'Mailbox created', 'Mailbox password reset', 'Alias created', 'Member role changed']) {
    await expect(page.getByRole('cell', { name: action }).first()).toBeVisible();
  }
  await expect(page.getByRole('cell', { name: superAdmin.email }).first()).toBeVisible();
});

test('refuses an identity provider on a private address', async ({ page }) => {
  await page.goto(`${orgPath}/sso`);
  await page.getByRole('button', { name: 'Connect provider' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Issuer URL').fill('http://10.1.2.3/realms/acme');
  await dialog.getByLabel('Client ID').fill('postarix');
  await dialog.getByLabel('Client secret').fill('secret');
  await dialog.getByRole('button', { name: 'Connect provider' }).click();
  await expect(dialog.getByText(/must be a public https address/)).toBeVisible();
});

test('explains when a domain has no single sign-on', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(`someone@${domain}`);
  await page.getByRole('button', { name: 'Sign in with your company account' }).click();
  await expect(page.getByText('Single sign-on is not set up for this domain.')).toBeVisible();
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

test('reaches every server section from the sidebar', async ({ page }) => {
  await page.goto('/admin');
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const [link, heading] of [
    ['Services', 'Services'],
    ['Logs', 'Logs'],
    ['Spam filter history', 'Spam filter history'],
    ['Mail queue', 'Mail queue'],
    ['Outgoing routing', 'Outgoing routing'],
    ['Content filters', 'Content filters'],
    ['Forwarding hosts', 'Forwarding hosts'],
    ['IP access', 'IP access'],
    ['DKIM keys', 'DKIM keys'],
    ['Administrators', 'Administrators'],
    ['Mail to everyone', 'Mail to everyone'],
    ['Templates', 'Domain templates'],
    ['API keys', 'API keys'],
    ['Customize', 'Customize'],
    ['Settings', 'Settings'],
  ]) {
    await nav.getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await expect(nav.getByRole('link', { name: /Rspamd web interface/ })).toHaveAttribute('href', '/api/rspamd-ui/');
  // The logs of the API itself are listed with the others.
  await page.goto('/admin/system/logs?service=api');
  await expect(page.getByRole('tab', { name: 'API' })).toHaveAttribute('aria-selected', 'true');
});

test('keeps server-wide mail policies', async ({ page }) => {
  const host = `${unique('relay').toLowerCase()}.example.test`;
  await page.goto('/admin/system/forwarding-hosts');
  await page.getByRole('button', { name: 'Add host' }).first().click();
  await page.getByRole('dialog').getByLabel('Host').fill(host);
  await page.getByRole('dialog').getByRole('button', { name: 'Add host' }).click();
  const hostRow = page.getByRole('row').filter({ hasText: host });
  await expect(hostRow).toBeVisible();

  await page.goto('/admin/system/ip-access');
  await page.getByRole('button', { name: 'Block a network' }).click();
  await page.getByRole('dialog').getByLabel('Network').fill('198.51.100.0/24');
  await page.getByRole('dialog').getByRole('button', { name: 'Block' }).click();
  const networkRow = page.getByRole('row').filter({ hasText: '198.51.100.0/24' });
  await expect(networkRow.getByText('Blocked')).toBeVisible();
  await networkRow.getByRole('switch').click();
  await expect(networkRow.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await networkRow.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(networkRow).toHaveCount(0);

  await page.goto('/admin/system/filters');
  await page.getByRole('button', { name: 'Add rule' }).first().click();
  await page.getByRole('dialog').getByLabel('Regular expression').fill('(casino|lottery) e2e');
  await page.getByRole('dialog').getByRole('button', { name: 'Add rule' }).click();
  const ruleRow = page.getByRole('row').filter({ hasText: '(casino|lottery) e2e' });
  await expect(ruleRow.getByText('File as junk')).toBeVisible();
  await ruleRow.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(ruleRow).toHaveCount(0);

  await page.goto('/admin/system/forwarding-hosts');
  await hostRow.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(hostRow).toHaveCount(0);
});

test('customizes the sign-in page', async ({ page, browser }) => {
  await page.goto('/admin/system/customize');
  await page.getByLabel('Footer').fill('Example Corp · Legal notice');
  await page.getByLabel(/Only single sign-on and passkeys/).check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved.', { exact: false })).toBeVisible();

  const visitor = await browser.newPage();
  await visitor.goto('/admin/login');
  await expect(visitor.getByText('Example Corp · Legal notice')).toBeVisible();
  await expect(visitor.getByLabel('Password')).toHaveCount(0);
  await visitor.getByRole('link', { name: 'Sign in with a password' }).click();
  await expect(visitor.getByLabel('Password')).toBeVisible();
  await visitor.close();

  await page.getByLabel('Footer').fill('');
  await page.getByLabel(/Only single sign-on and passkeys/).uncheck();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved.', { exact: false })).toBeVisible();
});
