import { expect, type Page, test } from '@playwright/test';
import { ApiClient, config, unique, waitForMessage } from '../src/support.js';
import { signInToWebmail } from './support.js';

const PASSWORD = 'organizer browser password';
let address = '';
let colleague = '';

test.beforeAll(async () => {
  const admin = new ApiClient();
  await admin.signIn(config.adminEmail, config.adminPassword);
  const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Organizer', slug: unique('organizer') });
  const domain = await admin.ok<{ id: string }>('POST', `/api/orgs/${org.id}/domains`, { name: `${unique('org')}.test` });
  await admin.ok('POST', `/api/orgs/${org.id}/domains/${domain.id}/verify`);
  address = (await admin.ok<{ address: string }>('POST', `/api/orgs/${org.id}/mailboxes`, { domainId: domain.id, localPart: 'olga', password: PASSWORD, displayName: 'Olga' })).address;
  colleague = (await admin.ok<{ address: string }>('POST', `/api/orgs/${org.id}/mailboxes`, { domainId: domain.id, localPart: 'pablo', password: PASSWORD, displayName: 'Pablo' })).address;
});

const signIn = (page: Page) => signInToWebmail(page, address, PASSWORD);

test('plans an event in the calendar', async ({ page }) => {
  const title = unique('Design review');
  await signIn(page);
  await page.getByRole('navigation', { name: 'Apps' }).first().getByRole('link', { name: 'Calendar' }).click();
  await expect(page).toHaveURL(/\/calendar/);
  await page.getByRole('button', { name: 'New event' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Place').fill('Room 4');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const chip = page.getByRole('grid').getByRole('button', { name: new RegExp(title) });
  await expect(chip).toBeVisible();

  await chip.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('grid').getByRole('button', { name: new RegExp(title) })).toHaveCount(0);
});

test('shows events by week and by day, and adds one from a time slot', async ({ page }) => {
  const title = unique('Standup');
  await signIn(page);
  await page.goto('/calendar?view=week');
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Week' }).waitFor();
  // Today's 10 o'clock slot.
  const today = new Intl.DateTimeFormat('en-US', { dateStyle: 'full' }).format(new Date());
  await page.getByRole('group', { name: today }).getByRole('button', { name: /^New event, .*10/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('group', { name: today }).getByRole('button', { name: new RegExp(title) })).toBeVisible();

  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Day' }).click();
  await expect(page).toHaveURL(/view=day/);
  await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible();
  await page.getByRole('button', { name: 'Next day' }).click();
  await expect(page.getByRole('button', { name: new RegExp(title) })).toHaveCount(0);
});

test('keeps contacts and suggests them when writing', async ({ page }) => {
  const last = unique('Gomez').replace(/-/g, '');
  await signIn(page);
  await page.getByRole('navigation', { name: 'Apps' }).first().getByRole('link', { name: 'Contacts' }).click();
  await page.getByRole('button', { name: 'New contact' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('First name').fill('Lucía');
  await dialog.getByLabel('Last name').fill(last);
  await dialog.getByLabel('Email 1').fill(`lucia.${last.toLowerCase()}@acme.example`);
  await dialog.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByRole('heading', { name: `Lucía ${last}` })).toBeVisible();

  await page.getByRole('navigation', { name: 'Apps' }).first().getByRole('link', { name: 'Mail' }).click();
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByRole('dialog').getByLabel('To').fill(last.slice(0, 6));
  const option = page.getByRole('option', { name: new RegExp(last) });
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.getByRole('dialog').getByLabel('To')).toHaveValue(new RegExp(`lucia\\.${last.toLowerCase()}@acme\\.example`));
});

test('sets an automatic reply and forwarding', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: new RegExp(address.replace(/[.]/g, '\\.')) }).first().click();
  await page.getByRole('menuitem', { name: 'Automatic reply and forwarding' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reply to people who write to me').check();
  await dialog.getByLabel('Message').fill('I am away until Monday.');
  await dialog.getByLabel('Forward my mail').check();
  await dialog.getByLabel('To', { exact: true }).fill('olga.private@outside.example');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Saved.');
  await dialog.getByRole('button', { name: 'Close' }).first().click();

  // Reopened, it shows what the server keeps.
  await page.getByRole('button', { name: new RegExp(address.replace(/[.]/g, '\\.')) }).first().click();
  await page.getByRole('menuitem', { name: 'Automatic reply and forwarding' }).click();
  await expect(page.getByRole('dialog').getByLabel('Message')).toHaveValue('I am away until Monday.');
  await expect(page.getByRole('dialog').getByLabel('To', { exact: true })).toHaveValue('olga.private@outside.example');
});

test('invites a colleague, who answers from the message', async ({ browser }) => {
  const title = unique('Budget');
  const olga = await browser.newPage();
  await signInToWebmail(olga, address, PASSWORD);
  await olga.goto('/calendar');
  await olga.getByRole('button', { name: 'New event' }).click();
  const dialog = olga.getByRole('dialog');
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Guests').fill(`${colleague}, `);
  await dialog.getByRole('button', { name: 'Save and send' }).click();
  await expect(dialog).toBeHidden();
  // Once the calendar shows the event with its guests.
  await olga.getByRole('grid').getByRole('button', { name: new RegExp(`${title}.*With guests`) }).click();
  await expect(olga.getByRole('dialog').getByRole('list', { name: 'Answers' })).toContainText(`${colleague}Not answered`);
  await olga.close();

  await waitForMessage(colleague, PASSWORD, `Invitation: ${title}`);
  const pablo = await browser.newPage();
  await signInToWebmail(pablo, colleague, PASSWORD);
  await pablo.getByRole('list', { name: 'Messages' }).getByRole('link', { name: new RegExp(`Invitation: ${title}`) }).click();
  const card = pablo.getByRole('region', { name: 'Invitation' });
  await expect(card).toContainText(title);
  await card.getByRole('button', { name: 'Going', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Going', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await pablo.goto('/calendar');
  await expect(pablo.getByRole('grid').getByRole('button', { name: new RegExp(title) })).toBeVisible();
  await pablo.close();
});

test('shares a calendar with a colleague', async ({ browser }) => {
  const olga = await browser.newPage();
  await signInToWebmail(olga, address, PASSWORD);
  await olga.goto('/calendar');
  await olga.getByRole('button', { name: /^Share / }).first().click();
  const dialog = olga.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Add person' }).click();
  await dialog.getByLabel('Person 1', { exact: true }).fill(colleague);
  await dialog.getByRole('button', { name: 'Save sharing' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Sharing saved.');
  await olga.close();

  const pablo = await browser.newPage();
  await signInToWebmail(pablo, colleague, PASSWORD);
  await pablo.goto('/calendar');
  await expect(pablo.getByRole('list', { name: 'Shared with you' })).toContainText(address);
  await pablo.close();
});
