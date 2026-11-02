import { expect, type Page, test } from '@playwright/test';
import { ApiClient, config, unique } from '../src/support.js';
import { signInToWebmail } from './support.js';

const PASSWORD = 'organizer browser password';
let address = '';

test.beforeAll(async () => {
  const admin = new ApiClient();
  await admin.signIn(config.adminEmail, config.adminPassword);
  const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Organizer', slug: unique('organizer') });
  const domain = await admin.ok<{ id: string }>('POST', `/api/orgs/${org.id}/domains`, { name: `${unique('org')}.test` });
  await admin.ok('POST', `/api/orgs/${org.id}/domains/${domain.id}/verify`);
  address = (await admin.ok<{ address: string }>('POST', `/api/orgs/${org.id}/mailboxes`, { domainId: domain.id, localPart: 'olga', password: PASSWORD, displayName: 'Olga' })).address;
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
